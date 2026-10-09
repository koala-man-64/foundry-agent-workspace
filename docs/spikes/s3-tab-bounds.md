# Spike S3: tab bounds under display scaling and zoom

**Question** ([plan](../wpf-webview2-migration.md), spike table): does an integrated-browser tab sit exactly on the area the UI gives it, at every display scale and UI zoom, and does it hide behind modals?

**Exit criterion:** at most 1 device px of error at 100/125/150/200% and zoom 2; hidden behind modals. If S3 misses it, decision 7 applies unless Rudy decides otherwise: ship with **Attach to chat** disabled.

**How it runs (Rudy's choice, 8 October 2026):** the harness measures while Rudy changes Windows display scaling himself. It never changes a system setting.

## What the harness does

`tests/Foundry.Spikes.BrowserSurface` builds the plan's browser surface (section 6) on a real, visible window:
- A WPF window, per-monitor DPI aware (PerMonitorV2), with the app UI in one WebView2 environment.
- One tab in a separate browser environment and user-data folder, inside its own child window (the tab host).
- The tab is positioned in device pixels at CSS px × the UI's `ZoomFactor` × its `RasterizationScale`, each edge rounded on its own. It re-syncs on `ZoomFactorChanged`, `RasterizationScaleChanged` and resize.

The UI page runs `BrowserPanel.tsx`'s `sendBounds` unchanged. It sends whole CSS pixels, rounded inward and clamped to the viewport, and suppresses repeats. A display-scale change that leaves CSS pixels alone therefore sends nothing, and the host must re-sync by itself.

At each display scale it measures every combination of:
- two window sizes (one of them odd-sized);
- two layouts of the browser area: every edge on a whole CSS pixel (*aligned*), or every edge on a fraction of one (*fractional*, as a dragged inspector width or a zoomed flex layout produces);
- UI zoom 1 and 2.

For each combination it photographs the screen:
- **Painted area:** first with the tab hidden. The UI paints the browser area solid magenta.
- **Two tab placements**, the tab painting solid green:
  - *Renderer*: the UI's whole-pixel bounds. This is the design under test.
  - *Exact*: the page's fractional rectangle. A diagnostic that separates the UI's rounding from the platform's placement.

The error is the distance between the edges of the green and magenta rectangles, in device pixels, per edge. Then it checks two modals:
- **Confirmation:** the UI's confirmation dialog must hide the tab, and the tab must come back in the same place.
- **Native dialog:** the host must hide the tab while a native folder dialog is open (`index.ts:151`). The dialog closes by itself.

`TabGeometryTests` (in `Foundry.WebView2.Tests`) pins the arithmetic and the pixel classification. A harness bug there would turn into a false pass.

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
4. When the console says `Next: set Windows display scaling to 125%`, open **Settings > System > Display > Scale** and choose 125%. The harness notices the change and measures again about 2 seconds later. Repeat for 150% and 200%. Windows may offer to sign you out to fix some apps; that is not needed.
5. Restore your usual scale, then type `q` and Enter in the console, or close the window.

The results land in `test-results/spikes/s3-tab-bounds/<time>/`:
- `summary.md`: the verdict, a worst-error table per scale and zoom, every placement, and the modal checks;
- `records.jsonl`: every measurement with all its geometry;
- `log.txt`.

If a measurement says *disturbed*, something covered the area being photographed. Press Enter in the console to measure again.

Options:
- `-- bounds --once` measures the current scale and exits.
- `-- bounds --simulate 125,150,200` sets both webviews' rasterization scale directly, with monitor detection off, on an unchanged display. It checks the arithmetic, not Windows' DPI handling, and its results are never evidence for the exit criterion.

## Preview (8 October 2026, before Rudy's run)

Rudy's display was at 100%, so Claude ran the 100% measurement for real and the other scales simulated. The table gives the worst edge error over both window sizes.

| Scale | Zoom | Renderer, aligned | Renderer, fractional | Exact, aligned | Exact, fractional |
|---|---|---|---|---|---|
| 100% (real) | 1 | 0 px | 1 px | 0 px | 0 px |
| 100% (real) | 2 | 0 px | 1 px | 0 px | 0 px |
| 125% (simulated) | 1 | 0 px | 1 px | 0 px | 0 px |
| 125% (simulated) | 2 | 0 px | 2 px | 0 px | 0 px |
| 150% (simulated) | 1 | 0 px | 1 px | 0 px | 0 px |
| 150% (simulated) | 2 | 0 px | 2 px | 0 px | 0 px |
| 200% (simulated) | 1 | 0 px | 1 px | 0 px | 0 px |
| 200% (simulated) | 2 | 0 px | 3 px | 0 px | 0 px |

Both modal checks passed at every scale.

What the preview shows, pending the real run:
- **Placement is exact.** From the fractional rectangle, the tab lands on the painted area to the pixel.
- **The UI's rounding is the error.** `sendBounds` rounds each fractional edge inward to a whole CSS pixel before the host multiplies by zoom and scale. The tab then stops short of a fractional edge by up to zoom × scale device pixels minus a fraction.
- **Where it misses.** The criterion holds on aligned layouts everywhere and at zoom 1. It is missed on fractional layouts at zoom 2: 2 px at 125% and 150%, 3 px at 200%.
- **What kind of error.** The tab never overlaps the UI; a sliver of the area's background shows. The input ladder's overlay follows the tab's actual rectangle, so input control is unaffected.
- **Electron.** Electron receives the same whole CSS pixels, and `syncViews` passes them on as DIPs without the zoom factor (`browser-manager.ts:223`). Its zoom-2 placement was not measured here.

## What Rudy's run decides

If the real scales confirm the preview, the miss is the UI's whole-pixel bounds, not WebView2 or the host. The options are:
1. **Accept the inset.** Restate the criterion as "at most 1 device px beyond the UI's whole-pixel rounding" (met in the preview). No code or protocol change.
2. **Send fractional CSS pixels.** Drop the inward rounding in `BrowserPanel` and let `BrowserBoundsSchema` carry numbers rather than integers. This is a protocol change, frozen until cutover unless Rudy adds it as a planned delta. The preview's *Exact* column shows it meets the criterion.
3. **Apply decision 7** and ship with **Attach to chat** disabled. The miss is cosmetic and does not affect input control, which makes this a heavy response.

A partial alternative is to make the browser area's edges whole CSS pixels in the UI's layout. The layout cannot guarantee it at every zoom, because a window width divided by zoom 1.1 is fractional.
