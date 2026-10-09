# Spike S3: tab bounds under display scaling and zoom

**Question** ([plan](../wpf-webview2-migration.md), spike table): does an integrated-browser tab sit exactly on the area the UI gives it, at every display scale and UI zoom, and does it hide behind modals?

**Exit criterion:** at most 1 device px of error at 100/125/150/200% and zoom 2; hidden behind modals. If S3 misses it, decision 7 applies unless Rudy decides otherwise: ship with **Attach to chat** disabled.

**How it runs (Rudy's choice, 8 October 2026):** the harness measures while Rudy changes Windows display scaling himself. It never changes a system setting.

**Status (9 October 2026): not run, by Rudy's decision.** The preview below is S3's only evidence. Real-DPI verification falls to P3's exit gate, which runs `browser.spec` at 100/150/200% DPI and zoom 2. The plan's S3 row holds the open inset decision. The harness stays available.

## What the harness does

`tests/Foundry.Spikes.BrowserSurface` builds the plan's browser surface (section 6) on a real, visible window:
- A WPF window, per-monitor DPI aware (PerMonitorV2), with the app UI in one WebView2 environment.
- One tab in a separate browser environment and user-data folder, inside its own child window (the tab host).
- The tab is positioned in device pixels at CSS px × the UI's `ZoomFactor` × its `RasterizationScale`, each edge rounded on its own.
- The host re-syncs the tab by itself on `ZoomFactorChanged`, `RasterizationScaleChanged` and resize.

The UI page runs `BrowserPanel.tsx`'s `sendBounds` unchanged. It sends whole CSS pixels, rounded inward and clamped to the viewport, and suppresses repeats. A display-scale change that leaves CSS pixels alone therefore sends nothing, and only the host's own event handling can move the tab.

### Each pass

Each pass, at the current display scale, measures:
1. **As left.** The tab exactly where the host's event handling left it after the last change, before the harness moves, resizes or zooms anything. After a scale change this is the only test that the host re-synced by itself.
2. **Every combination of:**
   - two window sizes (one odd-sized);
   - two layouts of the browser area: every edge on a whole CSS pixel (*aligned*), or every edge just past one (*fractional*). The fractional edges sit 0.02 and 0.97 past a whole pixel on the left and right, the near-worst case for the UI's inward rounding. They sit about half a pixel past on the top and bottom;
   - UI zoom 1 and 2.

### For each combination

The UI paints the browser area solid magenta; the tab is solid green. The harness photographs the screen three times, each photograph taken twice and kept only when both agree:
1. **The tab as designed**, where the host's events put it. The harness has not synced it itself, so a missed event shows as an error. The host's rectangle is also checked against the design's arithmetic: its own re-sync may take up to 500 ms after the UI settles, and the record keeps how long it took.
2. **The painted area**, with the tab hidden.
3. **A diagnostic:** the tab placed from the page's fractional rectangle. It separates the UI's rounding from the platform's placement.

The error is the distance between the edges of the green and magenta rectangles, in device pixels, per edge.

### Modals

- **Confirmation:** the UI's confirmation dialog must hide the tab, and the tab must come back in the same place.
- **Native dialog:** the host's own rule, from `index.ts:151`, is to hide the tab while a native dialog is open. The check confirms that the hidden tab stays off screen during the dialog's modal loop and comes back in place. The harness hides the tab and closes the dialog itself.

### Outcomes and verdict

Each measurement is *pass*, *FAIL* or *obstructed*:
- **FAIL:** a missing tab, a seam along the tab's edge, or an edge more than 1 px off.
- **Obstructed:** something that is neither the UI nor the tab covered the area. That says nothing about the tab; the harness retries it, and is never counted as a pass.

A scale is:
- **met** when its latest pass ran completely and every placement of the design and both modal checks passed;
- **not met** when any of them failed;
- **incomplete** otherwise.

A pass whose display scale changed midway is discarded. S3 as designed is met only when all four scales are met.

The summary also reports:
- **Earlier passes at the same scale.** The verdict uses the latest pass, but the summary lists any earlier pass that came out differently, so a failure is never quietly replaced by a later clean pass.
- **The host's re-sync.** It counts only the passes that a display-scale change started.
- **A rasterization-scale warning.** It warns when the UI's rasterization scale differs from the display scale (text scaling, for example).

`TabGeometryTests` (in `Foundry.WebView2.Tests`) pins the arithmetic and the pixel classification.

## Run it (about 5 minutes)

1. Keep the harness window unobstructed while it measures. It stays on top only while measuring.
2. From the repository root, in a terminal:
   ```
   dotnet run --project tests/Foundry.Spikes.BrowserSurface -c Release -- bounds
   ```
3. The window measures the current scale, which takes about 15 seconds:
   - it switches through sizes, layouts and zooms;
   - a folder dialog opens and closes by itself.

   Do not touch it while the status line at its top left says *measuring*.
4. When the console says `Next: set Windows display scaling to 125%`, open **Settings > System > Display > Scale** and choose 125%. The harness notices and measures again about 2 seconds later. Repeat for 150% and 200%.
   - If it says some measurements were obstructed, press Enter in the console to measure again.
   - Windows may offer to sign you out to fix some apps; that is not needed.
5. Restore your usual scale, then type `q` and Enter in the console, or close the window.

The results land in `test-results/spikes/s3-tab-bounds/<time>/`:
- `summary.md`: the verdict per scale, worst-error tables, every placement with its outcome and reason, and the modal checks;
- `records.jsonl`: every measurement of every completed pass, with all its geometry;
- `log.txt`.

Options:
- `-- bounds --once` measures the current scale and exits.
- `-- bounds --simulate 125,150,200` sets both webviews' rasterization scale directly, with monitor detection off, on an unchanged display. It checks the arithmetic, not Windows' DPI handling, and its results are never evidence for the exit criterion.

## Preview (9 October 2026, before Rudy's run)

Claude ran 100% for real, on Rudy's display at the time (5120×1440), and the other scales simulated. The table gives the worst edge error over both window sizes. Every judged placement was unobstructed, and the host had re-synced the tab by itself in all of them.

| Scale | Zoom | Design, aligned | Design, fractional | Exact, aligned | Exact, fractional |
|---|---|---|---|---|---|
| 100% (real) | 1 | 0 px | 1 px | 0 px | 0 px |
| 100% (real) | 2 | 0 px | **2 px** | 0 px | 0 px |
| 125% (simulated) | 1 | 0 px | 1 px | 0 px | 0 px |
| 125% (simulated) | 2 | 0 px | **3 px** | 0 px | 0 px |
| 150% (simulated) | 1 | 0 px | **2 px** | 0 px | 0 px |
| 150% (simulated) | 2 | 0 px | **3 px** | 0 px | 0 px |
| 200% (simulated) | 1 | 0 px | **2 px** | 0 px | 0 px |
| 200% (simulated) | 2 | 0 px | **4 px** | 0 px | 0 px |

Both modal checks passed at every scale.

What the preview shows, pending the real run:
- **Placement is exact.** From the fractional rectangle, the tab lands on the painted area to the pixel, and the host re-syncs on its own events.
- **The UI's rounding is the error.** `sendBounds` rounds each fractional edge inward to a whole CSS pixel before the host multiplies by zoom and scale. The tab can therefore stop short of a fractional edge by up to zoom × scale device pixels. That is 4 px at 200% and zoom 2, as measured, and already 2 px at zoom 2 on a 100% display.
- **Where it misses.** Aligned layouts meet the criterion everywhere. Near-worst fractional ones miss at zoom 2 at every scale, and at zoom 1 from 150% up. How fractional the real panel's edges are depends on the live layout (a dragged inspector width, a zoom that does not divide the window evenly); this spike does not measure the real app.
- **What kind of error.** The tab never overlaps the UI: a sliver of the area's background shows. The input ladder's overlay follows the tab's actual rectangle, so input control is unaffected.
- **Electron.** Electron receives the same whole CSS pixels, and `syncViews` passes them on as DIPs without the zoom factor (`browser-manager.ts:223`). Its placement was not measured here, so this is not evidence of parity.

## What Rudy's run decides

If the real scales confirm the preview, the miss is the UI's whole-pixel bounds, not WebView2 or the host. The options are:
1. **Accept the inset.** Restate the criterion for the design: the error stays within the UI's whole-pixel rounding, at most zoom × scale device px (4 px at 200% and zoom 2), always short of the area and never over the UI. No code or protocol change.
2. **Send fractional CSS pixels.** Drop the inward rounding in `BrowserPanel` and let `BrowserBoundsSchema` carry numbers rather than integers. This is a protocol change, frozen until cutover unless Rudy adds it as a planned delta. The preview's *Exact* column shows it meets the criterion.
3. **Apply decision 7** and ship with **Attach to chat** disabled. The miss is cosmetic and does not affect input control, which makes this a heavy response.

A partial alternative is to make the browser area's edges whole CSS pixels in the UI's layout. The layout cannot guarantee it at every zoom, because a window width divided by zoom 1.1 is fractional.
