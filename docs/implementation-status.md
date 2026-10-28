# Implementation status

## Default look, part 5: two-pane Focus and short windows — 27 October 2026

Task id `ui-look-focus-20261027`, the fifth slice of the default look Rudy chose on 27 October.
- **Scope.** Renderer only: `styles.css`, and one `data-tray` attribute each in `App.tsx` and `Orchestration.tsx`. There is no protocol, IPC channel, runtime, provider, schema, dependency or main-process change. Nothing is dual-landed in C#.
- **Source.** Two read-only analysts specified the two panes and the short-window tier against the current stylesheet. Where they differed, the owner chose on measured evidence.

**What changed**
- **Two panes from 1180px.** In Focus, while the tray is on screen, the tray becomes a pane beside the transcript, at 5fr to 7fr (491 and 689px at 1180, 617 and 863px at 1480). The header and composer span both panes on the 24px lane.
  - **The switch.** It is a `data-tray` attribute, set from the same condition that renders the tray, so the two cannot disagree. There is no `:has()`.
  - **Placement only.** The DOM order, and so the reading and Tab order, is unchanged. The attention banner keeps a full row of its own under the panes, so it never sits beside the tray ahead of it.
  - **The pane.** It fills its rows instead of stopping at the 70vh cap, and a hairline marks its left edge. The limits note is capped at 80ch there.
  - **Coordinated view.** The coordinator detail is the grid, under the header and agent tree. A child's view keeps its tray stacked, capped at the Focus measure, and choosing a chip moves nothing.
  - **Transcript meta.** In the 5fr pane at 1480 the transcript is under 620px, so the author and time sit inline above the text. The hanging column returns from about 1640px.
- **Short windows.** At 760px tall and below, the stacked tray tightens only its chrome spacing, through new `*-short` roles:
  - the summary line;
  - the limits note's vertical padding and margin;
  - the first live card's top margin;
  - the card heading and field gaps;
  - the Approve row's top margin.
  - Evidence text, card padding, the decision buttons and the note's wording are unchanged. The transcript floor drops to 84px, 64px in Compact.
  - **760px, not 700px.** A height sweep put Approve out of view just above a 700px tier, which is the prototype's.
- **Transcript fix.** In Focus the transcript is sized from a flex basis of 0. Sized by its content, a long transcript took space from the tray in proportion to its length and squeezed a pending decision to a strip, whatever the floor. The defect is on main too.
- **Sizes.**
  - The Focus column is 1100px, 1180px in Compact.
  - The stacked tray cap is 70vh, 68vh in Compact.
  - The transcript floor is 92px, 72px in Compact.

**Validation** (local, Windows, isolated fixtures)
- **`pnpm check`** (at `8d1b38e`): typecheck and lint pass. Vitest: 846 of 850 in the parallel run.
  - **The 4 failures.** They are load timeouts in the runtime git-operations and publish tests, which this change does not touch. Serially those files pass, 47 of 47.
  - **An earlier run.** At `a50bbdf`, while four reviewers' probes ran beside it, 129 tests failed in 23 runtime and integration files. Serially those files passed, 294 of 294.
  - **New unit checks.**
    - **Short roles.** All 14 are read only inside a max-height query, never set there, and never above their base in either style.
    - **Sizes and the fix.** The Focus sizes are pinned, as is the transcript's flex-basis rule in both views.
    - **The two-pane block.** It checks the areas in DOM order, the banner's own row, one row track per row of areas in both grids, the ratio in both grids and the note cap. It also checks for no `:has()`, no `order`, no `display: none` and no colour.
    - **Block order.** The short block comes after the two base rules it ties with.
- **`pnpm test:e2e`**: 35 of 35 pass, at `8d1b38e`.
  - **New `focus.spec.ts` test.**
    - At 1480×940 the tray sits beside the transcript, under the header and above the composer, which both span the panes. Every child has its own area, and the DOM order is unchanged.
    - It is stacked at 1176px and beside again at 1180px.
    - At 1000×680 the command card's Approve is inside the tray and the window, in Comfortable and in Compact, beside a 3000px transcript that keeps its floor.
    - The Focus column is 1100px, 1180px in Compact.
  - **`orchestration.spec.ts`.**
    - At 1480×940 the coordinator's tray sits beside its transcript under the agent tree, and every child has its area.
    - A child's view keeps its tray stacked, and the agent tree does not move.
    - At 1000×680 a long coordinator transcript keeps its floor, and Approve stays in view.
  - **An earlier run.** At `a50bbdf` one test failed: personal-workspace's script grant, refused with "Grant must expire within 30 days." That is the race #72 fixes, and the test passes alone.
- **Measurements** (`logs/probe-fit*.log`, `logs/probe-coord1.log`). Approve's slack in the stacked tray, at 1000×680 and at the 644px floor:

  | Stacked tray | 1000×680 | 644px floor |
  |---|---|---|
  | Chat, Comfortable | 40px | 4px |
  | Chat, Comfortable, with Load older messages | 16px | −20px |
  | Chat, Compact (either way) | 56px | 31px |
  | Coordinated, Comfortable, long history | 66px | 30px |

  - **Before the fix.** In the coordinated view, a long history shrank the tray to 69px, and Approve sat 217px out of view.
- **Mutants.** Thirteen mutants were run. Eleven fail a test:
  - the flex basis, in both views;
  - the short tier and the 70vh cap;
  - the breakpoint;
  - both `data-tray` attributes;
  - the banner's own row;
  - the coordinator grid;
  - an extra row track;
  - a composer without an area.
  - The two that survive are single short-tier rules (see known limits).
- **Harness** (`.local/verification/ui-look-focus-20261027/render1`): 252 captures in seven presets, including the new coordinated Focus state and the 1000×644 floor.
  - Contrast, overflow and 24×24 target lists are empty. Under forced colours, Light and Dark match in 36 of 36 captures.
  - Approve is flagged out of view only at the floor, in Comfortable, with Load older messages shown: the known limit.
- **Independent review**: four reviewers (Sonnet, high, from their agent definitions), on code and tests, the approval surface, the rendered result and maintainability.
  - All four said GO with no P0 to P2, so nothing needed adversarial verification.
  - Fixed from their P3s: the grid placement and row checks, the block-order guard, the shared e2e helpers, polling a tall size by its width only, and the comments.
- **Not run**: `package:dir` and `smoke:package`, because nothing in packaging or dependencies changed.

**Known limits**
- **The true minimum window.** The window's 680px minimum is an outer height, so the smallest content is about 644–650px at any display scale (measured at 125%: 644px).
  - There, with Load older messages shown (24px), Comfortable's Approve for the tallest card (the command) sits about 20px below the tray's visible area. A notice above the transcript costs the same way (31px, 27px in Compact). The cards scroll, a scrollbar shows it, and the tray is reachable by keyboard.
  - Without that button it has 4px to spare. Compact has 31px either way, and at 680px of content Comfortable keeps 16px with the button.
  - Closing it would take the transcript floor to 64px or a third height tier; neither is done, and there is no sticky Approve by decision.
- **Layout shift.** In windows wider than about 1150px, the header and composer move from the centred 1100px column to the full-width lane when a tray appears, and back when it clears.
- **Child view.** It stays stacked. At 1480 its panel sits on the left lane, capped at 1100px.
- **No tonal band on the pane, Rudy's call.** In Light the tray pane stays on `--surface-inspector`, the canvas, where the prototype draws a tonal band. The pane is marked by the 2px needs-you rule, a hairline and the white awaiting card. A sunken band would hide decided cards' evidence wells, which share that fill; adding it is one background token plus well tokens.
- **Seen in the new captures, not changed here.** Below 1180px, and in a child's view, the coordinated tray is inset twice: its cards sit 48px in, where the chat tray's sit 24px in.
- **Tests.** Removing a single short-tier rule (the first card's margin or the summary padding) leaves Approve in view at 1000×680, which has about 40px to spare, so no e2e check fails for it. The unit checks still require every short role to be read. Removing the whole tier fails.

## Default look, part 4b: Balanced's Usage page, Settings dialog and coordinated view — 27 October 2026

Task id `ui-look-panels-20261027`, the second half of the fourth slice of the default look Rudy chose on 27 October.
- **Scope.** Renderer CSS only. There is no markup, protocol, IPC channel, runtime, provider, schema, dependency or main-process change. Nothing is dual-landed in C#.
- **Source.** Three read-only analysts turned the look map into exact specs against the current stylesheet. The owner accepted their recommendations.

**What changed**
- **Usage page.**
  - **Figures.** Each figure sits right-aligned beside its label. The label track is `auto`, so a long figure wraps in its own column and never squeezes the label. The figure keeps 24px Georgia: type is unchanged.
  - **Charts.** The daily trend is 88px and the request chart 96px. Compact is 72px and 80px.
  - **Rows and controls.** Breakdown rows are one line where they fit. Date inputs and selects get a 28px floor to match the period buttons.
  - **Spacing.** The page and section spacing is Balanced's, and Compact steps below it.
  - **Hairlines.** The trend's baseline is a `--line-strong` hairline, so the cool `--viz-baseline` role is gone. The section and request-detail rules take the hybrid's hairlines.
  - **Contrast themes.** The chart's Reported key keeps a solid square in Windows contrast themes.
- **Settings dialog.**
  - **Width.** It is 780px in both styles, so `w-dialog` leaves the Compact exceptions.
  - **Label-left rows.** The model profile's fields and limits are label-left rows: a 112px column, 104px in Compact. The rule is scoped to the profile form's own fields, so the MCP form keeps its long labels above their fields.
  - **Appearance.** The Theme and Style radios sit on the same column, with their help text under them.
  - **Inputs.** Inputs and selects share one height: 29px, 27px in Compact.
  - **Head and spacing.** The eyebrow and title share a baseline. The head, form and MCP spacing are tighter.
  - **Removed.** The dead `.manage-dialog` width rule is gone.
  - **Scroll.** The dialog still scrolls at 940px tall, as it did before, because it holds the profile and the whole MCP section.
- **Coordinated view.**
  - **Agent tree.** It sits on the canvas with outlined chips. The selected chip has a 2px bar, a `--select` border and the new `--select-chip-bg`. In Light that is `--surface`, lighter than the rest, which fixes the darker selected chip deferred from part 1. Dark and High contrast keep `--select-soft`.
  - **Chips and cards.** The chips, child panel, assignment summary and Orchestration-tab cards move onto the ladder at Balanced's sizes and go flat.
  - **Child summary.** It loses the browser's default list margins, which about halves its height.
  - **Coordinator composer.** It sits on the transcript's lane instead of a second gutter in.
  - **Child view banner and tray.** They reach the pane edges, as the coordinator's do, in and out of Focus.

**Validation** (local, Windows, isolated fixtures)
- **`pnpm check`** (at `17af292`, part 4b merged with parts 4a and 3, #67 and #69): typecheck and lint pass. Vitest: 837 of 847 in the parallel run.
  - **The 10 failures.** They are timeouts and EBUSY cleanup errors in five runtime and integration files, including continuity, git-operations and repository-preview. This change does not touch them, and serially they pass, 77 of 77.
  - **New unit checks.** Stylesheet pins for the Usage card grid, the label-left settings rows, the selected agent chip's fill token and the child view's full-bleed banner and tray. `select-chip-bg` joins the theme contrast pairs for ink, muted ink and the selection.
- **`pnpm test:e2e`**: 34 of 34 pass, at `17af292` and before the merge.
  - **`style.spec.ts`.** A new test checks the settings dialog in both styles: 780px, no sideways scroll, each field beside its label on one shared edge, the MCP form stacked, and one field height (29px, 27px in Compact).
  - **`usage.spec.ts`.** Each figure sits beside its label, a breakdown row is under 40px tall, no label wraps, and a synthetic 300px card keeps its label whole.
  - **`orchestration.spec.ts`.** The child summary's gaps stay under 20px, and the coordinator composer starts on the transcript's edge.
- **Mutants.** Ten stylesheet mutants were run. Eight fail a test. The two that survive are the equivalent placement mutants named under known limits.
- **Harness** (`.local/verification/ui-look-panels-20261027/render2`): every preset and sheet has empty contrast, overflow and 24×24 target lists. Under forced colours, Light and Dark match in 32 of 32 captures.
- **Independent review**: two reviewers (Sonnet, high, from their agent definitions), one on code and tests and one on the rendered captures. Both said GO, with no P0 or P1.
  - Fixed: dialog selects 2px taller than the inputs, a wrapped dialog head with no gap, the Reported key vanishing in Windows contrast themes, and the child view's full-bleed rule having no test.
- **Not run**: `package:dir` and `smoke:package`, because nothing in packaging or dependencies changed.

**Known limits**
- **Settings.**
  - The dialog scrolls inside itself at 1480×940, so the prototype's no-scroll measurement (taken before the Appearance and Reasoning effort rows existed) is not claimed.
  - At 200% zoom of a 1000px window the two limit inputs are about 77px wide.
  - No Settings capture at 200% zoom exists.
- **Daily trend.** The live captures have no daily data, so its 88px bars are seen only on the synthetic sheet.
- **Equivalent mutants.** The Usage card keeps both explicit placement and auto-placement into its two-column template. Either alone keeps the figure beside the label, so removing one is invisible and no test can fail for it.

## Default look, part 4a: Balanced's inspector — 27 October 2026

Task id `ui-look-inspector-20261027`, the first half of the fourth slice of the default look Rudy chose on 27 October.
- **Scope.** Renderer CSS, class names in `ApprovalCard.tsx`, the default width in `layout.ts`, and the width the inspector shows in `App.tsx`. There is no protocol, IPC channel, runtime, provider, schema, dependency or main-process change. Nothing is dual-landed in C#.

**What changed**
- **Approval fields beside their labels.** In an approval list at least 508px wide (about 480px of a boxed card):
  - Short fields put their label in a 7.5rem column. Compact uses 88–112px.
  - Long evidence (a pre, a patch, the environment) keeps its label above and the full width, with the stacked layout's gaps. So does the Command block.
  - From 600px, the environment takes two columns and never splits an entry.
  - Narrower lists keep the stacked layout, and the inspector's Usage grid is unchanged.
- **A tighter inspector.**
  - Tabs are 28px rows with an even 8px gap.
  - Tools, file rows and panels tighten: 8px around approval and orchestration cards, 8px 12px elsewhere.
  - Files sizes to its rows, at most 40% of the inspector, and a long open file never squeezes it.
  - Activity is two-line ruled rows, with the time right-aligned beside the event and the evidence below. The timeline rule and its colour role (`--line-timeline`) are gone.
- **The default width follows the window.** It is 360px at 1000px, 400px at 1480px, 520px at 1700px and 640px from about 1920px, read at start.
  - A remembered (dragged) width always wins.
  - Either one is the chosen width, and the inspector shows it clamped to the window as it is now.
- **Narrowing the window.**
  - **The fix.** Narrowing the window no longer pushes the inspector off screen. Before, nothing re-clamped on a resize, so a wide default or a drag followed by a narrower window left the inspector past the window edge: 885px stayed in a 1100px window where 505px fits.
  - **What keeps the chosen width.** Widening the window shows the chosen width again. A style switch, a narrow start and a key press that changes nothing on screen no longer lower it.
  - **Arrow keys and the separator.** The keys step from the width on screen. The separator's maximum follows the window without re-rendering the app on every resize.

**Validation** (local, Windows, isolated fixtures)
- **`pnpm check`** (at `8968346`): typecheck and lint pass. Vitest: 823 of 835 in the parallel run.
  - **The 12 failures.** They are timeouts and EBUSY cleanup errors in six runtime and integration files: continuity, git-operations, projects, repository-preview, orchestration and publish. This change does not touch them, and serially they pass, 89 of 89.
  - **An earlier run.** At `d4c6db0`, git-operations' two cherry-pick tests timed out even alone, while another worktree's suites ran beside them.
  - **New unit checks.**
    - Stylesheet: the 508px container rule with the card field tokens, the long-field block and the 600px environment rule.
    - `layout.test.ts`: pins the width defaults (360, 400, 520 and 640px) and a remembered width that is not clamped to the start window.
- **`pnpm test:e2e`**: 33 of 33 pass.
  - **New `inspector-layout.spec.ts`.** In Comfortable and Compact, at 507, 508, 599 and 600px of list, it checks:
    - short fields beside their label;
    - long evidence stacked;
    - the environment's columns;
    - the gaps under a long field's label, the Command label and the Environment label.
    - It also checks the Activity row, and the file list beside a 4,000-line file.
  - **`inspector-width.spec.ts`.**
    - It narrows a window after a keyboard End to the limit. Before the fix, 885px stayed in a 1100px window.
    - It checks that the inspector ends inside the window and that the conversation keeps 320px.
    - It checks that a no-op key and a style switch keep the chosen width, that keys step from the shown width, and that the separator's maximum follows the window.
  - **`transcript.spec.ts`.** It checks that a clean profile opens at the window-relative default.
  - **Mutants.** Twelve mutants each fail their check, and the unmutated controls pass (`logs/mutants-review*.log`).
- **Harness** (`.local/verification/ui-look-inspector-20261027/render3`):
  - **The 189 captures in 7 presets.** Their contrast, overflow and 24×24 target lists are empty, and so are the sheets in every preset.
  - **High contrast.** No app text is below 7:1 in 25 captures. On the sheets, only the rail "+" glyph is below (5.5:1, as before). Under forced colours, Light and Dark match in 29 of 29 captures.
  - **The wide start (`render3-wide`).** The app started in a 1920×1080 window, with the inspector and the approval list at 640px. The 48 captures in 4 presets have empty lists.
    - Real command, edit and coordinated cards show the label column and the two-column environment.
    - Hashes and paths wrap, and the security line is verbatim.
- **Independent review.** Reviewers were Sonnet at high effort, from their agent definitions, in four rounds. All said GO, with no P0 or P1.
  - **Round 1** (layout and code, on `8fc2aa2`). Fixed:
    - the file list collapsing beside a long file (P2);
    - Compact's long-evidence gaps;
    - the environment threshold, from 608 to 600px;
    - regex-only tests.
  - **Round 2** (code and rendered layout, on `d4c6db0`). Fixed the Compact Command gap and the untested Compact gaps. The owner then found the inspector pushed off screen in a narrowed window (`3498f91`).
  - **Round 3** (React and tests, on `3498f91`). Fixed:
    - style switches, narrow starts and no-op keys lowering the chosen width;
    - the untested keyboard step after narrowing;
    - a stale separator maximum.
  - **Round 4** (on `8968346`). GO. Its one P3, Home while the window hides a larger width, cannot occur at the 1000px minimum window.
- **Not run**: `package:dir` and `smoke:package`, because nothing in packaging or dependencies changed.

**Known limits**
- **Layout switches with the list's width.** Approval cards change layout at the approval list's width, so dragging the inspector moves cards between the stacked and the label-column layouts. The 600px environment threshold clears the 640px default inspector with a scrollbar by about 7px.
- **Tab rows.** A coordinated task's inspector has more tabs, which wrap to a second even row at 640px (as the narrow inspector's already did).
- **The default is read at start.** A viewer who starts in a narrow window and widens it keeps the narrow window's default until they drag or restart. A remembered width is kept as chosen.
- **Live resizing.** While the window is narrower than the chosen width, the shown width changes on every resize event, so the app re-renders as the window is dragged narrower. It is correct but its cost is unmeasured.

## Default look, part 3: the transcript on the lane, with a hanging author column — 27 October 2026

Task id `ui-look-transcript-20261027`, the third slice of the default look Rudy chose on 27 October. Rudy picked the hanging author and time column explicitly. Renderer CSS plus one span in `Transcript.tsx`: no protocol, IPC channel, runtime, provider, schema, dependency or main-process change. Nothing is dual-landed in C#.

**What changed**
- **One lane.** The transcript shares the 24px lane with the header, banner and composer, in Comfortable and in Compact. Compact's centred 880px column is gone, so its transcript lines up with its header. A child agent's transcript sits on the detail pane's lane, like the coordinator's.
- **Rhythm and measure.**
  - Spacing: 12px between messages, 2px from the author line to the text, and an 8px 12px bubble.
  - Line height: 1.5.
  - Measure: a 33rem cap on the text and the bubble, about 64 characters of 15px prose.
- **Hanging column.** From a transcript 620px wide, the author and time hang in a 124px column beside the text (112px in Compact), and your messages align with the agent's.
  - The width check is a container query on `.messages`, so a dragged-wide inspector or the expanded browser falls back.
  - Narrower than that, the author line stays above the text and your bubble stays right-aligned.
  - The author is its own span. A compacted message's dashed rule moves to its text. The compacted tag stacks under the time.
  - Load buttons start at the text edge. The time wraps in its column (its exact value is in the title).

**Validation** (local, Windows, isolated fixtures)
- **`pnpm check`** (at `a489c5d`): typecheck and lint pass. Vitest: 833 of 835. The 2 failures are load timeouts in the runtime publish and continuity tests, which this change does not touch; serially those files pass, 30 of 30.
  - New stylesheet check: the container rule (on the transcript, at 620px, as a grid with the author column), the 124px column and the 33rem measure on the text and the bubble.
- **`pnpm test:e2e`**: 31 of 31 pass, including the new `transcript.spec.ts`.
  - At 1480×940 it checks that the author and time sit beside the text and that both speakers share the text edge.
  - At 1000×680 it checks that the author line is above the text, your bubble sits at its message's right edge, and the agent's text at its message's left edge.
  - With the container rule disabled, the spec fails.
- **Harness** (`.local/verification/ui-look-transcript-20261027/render2`):
  - Every preset and sheet has empty contrast, overflow and 24×24 target lists. High contrast has no app text below 7:1. Under forced colours, Light and Dark match in 29 of 29 captures.
  - At 1480×940 the chat shows 8 exchanges with the author column.
- **Independent review**: two reviewers (Sonnet, high, from their agent definitions), one on layout and who-said-what and one on code and tests. Both said GO, with no P0 or P1.
  - Fixed: Load buttons stretching across the text column, the time overrunning its column in longer locales, the narrow-layout e2e check that could not fail reliably, the column layout's margin reaching the compaction summary, and the child transcript inset twice.
- **Not run**: `package:dir` and `smoke:package`, because nothing in packaging or dependencies changed.

**Known limits**
- **Compacted messages.** In the column layout, a compacted message's dashed rule marks its text, not its Load button or error line. No real-app render shows a compacted or truncated message in the hanging layout, so they are verified by reading the CSS only.
- **Window resizes.** The 620px switch follows the transcript's own width, so resizing the inspector moves a transcript between the two layouts.

## Default look, part 2: Balanced sizes for the shell — 27 October 2026

Task id `ui-look-balanced-20261027`, the second of five slices of the default look Rudy chose on 27 October. It builds on part 1 (the hybrid's colours and structure) and lands Balanced's sizes for the shell:
- the control heights and the 24px lane;
- the task header;
- the composer and strips;
- the rail;
- one short-window tier;
- the Compact retune.

The transcript (rhythm, measure and the hanging author and time column), the panels and the inspector width, two-pane Focus, and the documentation screenshots follow as separate PRs. The decisions are in `.local/verification/ui-look-20261027/decisions.md`.

Renderer CSS plus the header markup only: no protocol, IPC channel, runtime, provider, schema, dependency or main-process change. Nothing is dual-landed in C#.

**What changed**
- **Controls.**
  - Buttons and rail views are 28px.
  - Approve and Reject keep their own 32px minimum and 34px rendered size.
  - The page lane is 24px.
  - Inputs are padded 6px 8px.
- **Task header.** It is one block of rows: the path, the title with its actions beside it, then the status, full width.
  - The wrapper div is gone in the chat, draft, empty and coordinated headers. CSS `order` sets the visual order.
  - The DOM keeps path, title, status, actions. A header narrower than 640px (its actions on their own row) returns to that order, so the status stays under its title.
  - The title is 24px, with 12px and 10px padding and no minimum height. At 1480×940 the header is 85px, down from 126px.
- **Composer and strips.**
  - The composer sits on the canvas under a hairline and is 61px tall.
  - Notices and the approval and upgrade banners are 6px strips. The approval banner has its own gap.
- **Rail.**
  - One edge, drawn on the shell.
  - Mode tabs and the view switch keep one row, with 11px labels at 1050px and below. A view label that still cannot fit is cut with an ellipsis; its accessible name stays whole.
  - The view switch is segmented, with a bottom selection bar. The pending-Inbox stripe follows the bar.
  - Inbox rows have two lines, with 13px titles that wrap.
  - Rows, the footer and Projects spacing are tighter.
  - A long needs-you chip wraps inside itself.
  - At 1480×940 the rail shows 11 Inbox rows, up from 6.
- **Short windows.** One tier at 760px tall (it was 720px): header padding, a 20px title, and a 34px composer (61px total at 1000×680 becomes 47px). The narrow-window header rule, which cancelled the tier, is gone.
- **Compact** stays the denser style on every role this PR changed. A new test holds it there.

**Validation** (local, Windows, isolated fixtures, at `8472ce1`)
- **`pnpm check`.** Typecheck and lint pass. Vitest passes 832 of 834. The 2 failures are load timeouts in runtime git and publish tests this PR does not touch; those files pass serially, 47 of 47. New tests:
  - **Compact ordering.** It compares every length and unitless number of each role, with shorthands expanded and bare zeros counted. At least 140 roles are compared. Only genuinely non-length roles may be skipped, and each of the four named exceptions is checked as real.
  - **Size and layout.** `--h-decision` is pinned at 32px. The header's child order and the short-window roles' placement are checked.
  - **Mutants.** Nine mutants all fail.
- **`pnpm test:e2e`.** 30 of 30 passed at `a567f4a`. At `8472ce1`, 29 of 30 passed. The failure was `personal-workspace.spec.ts`'s script grant, which the runtime refused with "Grant must expire within 30 days." That test passes 5 of 5 alone.
  - The renderer sends `Date.now() + 30 days` as the expiry, and the runtime refuses anything later than its own `now() + 30 days`. So the default sits exactly on the limit: a race this PR does not touch.
  - The e2e check that Compact's Send is shorter now uses 40px, under Comfortable's new 44px minimum.
- **Harness** (`.local/verification/ui-look-balanced-20261027/render2`).
  - All seven presets (Light, Dark, High contrast, Compact, Dark with Compact, and Light and Dark under forced colours) and all four sheets have empty contrast, overflow and 24×24 target lists. The state sheets now use the wrapper-less header.
  - High contrast has no app text below 7:1.
  - Under forced colours, Light and Dark render identically, 29 of 29.
- **Density at 1480×940.**

  | | Before | After | Balanced's target |
  |---|---|---|---|
  | Header | 126 | 85 | 89 |
  | Composer | 89 | 61 | 61 |
  | Inbox rows | 6 | 11 | 11 |
- **Density at 1000×680.** The header is 115px (target 127 to 148) and the composer 47px. The Inbox shows 6 rows in Comfortable and 8 in Compact, against a target of 7.
- **Independent review.** Three reviewers (Sonnet, high, from their agent definitions) covered density, trust and accessibility, and code and tests. All said GO with no P0 or P1. Their P2s and P3s are fixed or recorded in the decisions file:
  - the view switch wrapping at the narrowest rail;
  - the mode-tab strip's 1px slack;
  - the ordering test's skipped roles;
  - the cancelled short tier;
  - the status separated from its title in narrow headers;
  - the untested header rules;
  - the stale state-sheet header.
- **Not run.** `package:dir` and `smoke:package`, because nothing in packaging or dependencies changed.

**Known limits**
- **Approve below the fold.** Approve is out of view at 1000×680 and 200% zoom in the docked inspector, and in Comfortable's Focus. Two-pane Focus, in part 4, addresses Focus.
- **Inbox rows at 1000×680.** Comfortable shows 6 Inbox rows, one short of Balanced's 7. The count depends on the fixture's titles.
- **Forced colours.** The pending-Inbox mark and the open view's outline coincide when the Inbox is open. The count, the needs-decision group and its outlined row still carry the cue.

## Default look, part 1: the minimal hybrid as Foundry Light — 27 October 2026

Task id `ui-look-hybrid-20261027`. On 27 October Rudy chose the minimalism round's hybrid, combined with the density round's Balanced, as the default look, with a dark rail, a hanging author and time column and two-pane Focus. This first of five slices lands the hybrid's colours, type grammar and flat structure on the token system. Balanced's sizes and shell, the transcript column and panels, two-pane Focus and the documentation screenshots follow as separate PRs.

The port decisions are in `.local/verification/ui-look-20261027/decisions.md`. Renderer CSS and eight eyebrow strings only: no protocol, IPC channel, runtime, provider, schema, dependency or main-process change. Nothing is dual-landed in C#, because the WebView2 host loads the same renderer.

**What changed**
- **Foundry Light's colour tokens** take the hybrid's values:
  - warm cream canvas and warm ink;
  - a near-black warm rail;
  - terracotta for needs-you only, ochre for warnings, and crimson for danger.
  - The danger values are `#ba193c` and `#9f1337`. The hybrid's own crimson failed the distinctness test against terracotta, by ΔE 13.7 and 12.4 where 15 is required; these are the nearest values that pass.
  - The hairlines keep main's strength: the hybrid's were fainter than today's.
  - `--canvas-deep` stays `#e8e2d4`, so the window underlay is unchanged.
- **Selection and focus are ink**, drawn as weight 600 plus a 2px rule.
  - Fills that mark selection keep reading tokens (`--rail-selected`, `--select-soft`, `--choice-soft`, and the new `--bubble-*` for the user's message). Light's values equal the surface beneath, so Light is flat, and Dark and High contrast keep the fills they were reviewed with.
  - The Focus toggle and the Usage period buttons are underlined like any selection.
- **Shared structure, in every theme:**
  - Decided approval cards are flat rows on a hairline. The card that needs a decision, and unknown and failed outcomes, keep their box, 3px edge, inset ring and 12px spacing.
  - Inbox rows sit on hairlines. Only the needs-decision row is boxed and tinted (the new `--rail-needs-bg`).
  - Usage cards and lists are flat.
  - Badges are rings, except the filled needs-you badge.
  - Disabled controls are a dashed outline with no fill.
  - The database upgrade banner is ochre with a 4px rule.
  - The needs-you chip is the only filled header control.
  - The rail search field is outlined.
  - The agent's text has no left rule.
  - The privilege disclosure sits on the surface with weight 600 and its crimson rule; its wording is unchanged.
  - While a decision is pending, the open Inbox view keeps its selection bar with a terracotta stripe beside it. The closed Inbox view is terracotta ink beside its count, so open and pending never differ by hue alone.
- **Type:**
  - two weights, 400 and 600;
  - sentence-case labels instead of capitals and tracking;
  - state words capitalised by CSS, so the DOM text from `labels.ts` is unchanged;
  - evidence at 12px with a line height of 1.4;
  - radii of 3, 3, 4 and 8px;
  - a zero-specificity 24px minimum height for buttons and summaries.
  - The decorative large mark is hidden. Font families and the type scale are unchanged.
- **Windows contrast themes:** the forced-colours block restates the marks the flat styling draws with shadows: selection, the needs-decision row, the pending Inbox view, the tray, and disabled controls.
- **Rail Retry:** the button is drawn by the stylesheet, so its contrast is the tested error-box pair rather than Chromium's dark button face.

**Validation** (local, Windows, isolated fixtures, at `d69a218`)
- **`pnpm check`:** typecheck and lint pass. Vitest: 829 of 832 pass.
  - The 3 failures are load timeouts in runtime git and publish tests this change does not touch. Rerun serially, those files pass 47 of 47.
  - New tests:
    - pairs for the user bubble, the complete badge's ring, the needs-decision row's inks, outline and focus ring, and the upgrade banner rule;
    - checks for two weights, sentence case, the evidence values in every evidence rule, and the approval-card cascade order;
    - the forced-colours needs-decision marks.
  - Ten mutants all fail those tests.
- **`pnpm test:e2e`:** 30 of 30 pass.
- **Harness on the built app.**
  - The app captures (27 per preset, plus the keyboard-focused tray) have empty contrast, overflow and 24×24 target lists. The presets: Light, Dark, High contrast, Compact, Dark with Compact, and Light and Dark under forced colours.
  - The states, coverage, extras and dialog sheets are clean as well.
  - Under forced colours, Light and Dark render identically: 29 of 29 captures.
  - High contrast at 7:1 has no app text node below 7:1. On the sheets, only the rail "+" glyph is below (5.5:1, as before). Its rail Retry now passes, where before it was 4.6:1.
  - The evidence is in `.local/verification/ui-look-hybrid-20261027/render2`.
- **Independent review:** three reviewers (Sonnet, high, from their agent definitions) on visual fidelity and themes, trust and accessibility, and code and tests. All three said GO with no P0 or P1.
  - The two P2s were one issue: the open and pending Inbox views differed only by hue. It is fixed.
  - The P3s are fixed or recorded in the decisions file:
    - the last capitalised eyebrow;
    - lowercase status words;
    - a disabled subdued button with no disabled cue;
    - the New chat disc vanishing on hover;
    - the Retry margin;
    - the duplicate "No folder";
    - tests that could pass vacuously.
- **Not run:** `package:dir` and `smoke:package`, because nothing in packaging or dependencies changed. The packaged app and the installer are not verified.

**Known limits**
- **Secondary buttons** stay filled and unoutlined in Light, as Rudy decided earlier. The prototype outlines them.
- **The agent tree** in the coordinated view still sits on a tinted band, and its selected chip is darker than the unselected ones. It moves to the hybrid's flat rows in the panels slice.
- **Documentation screenshots** are now out of date. They are refreshed through `pnpm docs:screenshots` in the last slice.
- **Ink focus rings** on a selected row or tab sit on the same edge as its ink selection rule. The ring still reads as a full box against a single bar, with less margin than the old blue ring had against green.
- **Danger and needs-you** sit close in luminance (about 1.14:1). They are told apart by hue, fill against outline, and the written state word.

## Changes tab: words for an empty diff, and re-reads after approvals — 27 October 2026

Task id `ui-changes-tab-20261027`, the separate Changes-tab fix from the preset-themes plan. Renderer only: no protocol, IPC channel, runtime, provider, schema, dependency or main-process change. Nothing is dual-landed in C#, because the WebView2 host loads the same renderer.

**Defects fixed**
- **Blank tab.** When the worktree had no diff, the Changes tab showed nothing at all. The runtime returns an empty summary, and `diff?.summary ?? 'Loading changes…'` rendered the empty string.
- **Stale tab.** After an approved edit or command, Files and Changes kept their earlier contents until the task was reselected or Refresh pressed. The renderer read the diff only on selection, Refresh, commit and reconcile.
- **Dropped diff.** In the chat inspector, browsing into a folder while a refresh was in flight discarded that refresh's diff, because `loadFiles` bumps the counter the diff was guarded by. A coordinated view whose diff read failed showed "Loading changes…" forever.

**What changed**
- **One panel.** `ChangesPanel` in `worktree.tsx` serves both inspectors.
  - An empty diff reads "No changes to show. Secret-named files, and new files that are binary or too large to read, are not listed." The runtime leaves those out of the diff (`safeDiffPaths`, the untracked loop in `repository.ts`), so the words never claim a clean worktree.
  - An empty diff that is truncated reads "Some changes are not shown (truncated)."
  - A failed read is shown in place with Retry. If an older diff is still on screen, it says that diff may be out of date.
- **Re-reads.** Files and Changes re-read the worktree when an approval for the shown task settles in a state that may have touched files (`complete`, `failed` or `unknown`), and when its run completes or stops. That rule is `mayChangeWorktree`.
  - The chat inspector calls the latest render's Refresh through a ref, the same pattern as `snapshotWorker`.
  - The coordinated inspector re-reads its root inside its existing 250 ms event debounce, and now also re-reads the open file, on Refresh and after those events.
  - App skips coordinated roots, which the coordinated view owns.
  - Edits made outside the app raise no event, so Refresh still covers them.
- **Independent reads.** The listing and the diff are read in parallel and handled separately. A listing failure no longer blocks or mislabels the diff. The diff has its own version counter, so browsing supersedes only the listing.
- **Nothing gains authority.** The re-reads are the same read-only `files.list`, `task.diff` and `files.read` calls that Refresh makes. They approve, retry or reconcile nothing.

**Validation** (local, Windows, isolated fixtures)
- **`pnpm check`.**
  - Typecheck and lint pass.
  - Vitest passed 833 of 835 (initial commit run: 829 of 832). Every failure was a timeout or `EBUSY` in runtime git, publish and continuity tests this change does not touch, the same load pattern as the last PRs.
  - Rerun serially, the failed files pass, 47 of 47.
  - The new `worktree.test.ts` passes 8 of 8.
- **`pnpm test:e2e`.** 30 of 30 pass, on the initial commit and again after the review fixes.
- **Tests added.**
  - The chat inspector says the empty-diff sentence before an approval, shows the new file after approving without Refresh, and keeps the sentence after a reject. It keeps the diff when a folder is browsed during Refresh.
  - The coordinated inspector shows an open file's integrated content without Refresh, and the empty-diff sentence after completion.
- **Mutation checks.** All 6 mutants fail their test, and sources are restored by sha256 after each one:
  - the diff guarded by the listing counter again;
  - no automatic refresh in the chat view;
  - a blank empty diff;
  - no "may be out of date" line over an older diff;
  - no automatic refresh in the coordinated view;
  - no open-file re-read in the coordinated view.
- **Independent review.** Two reviewers (Sonnet, high, from their agent definitions), one on correctness, races and tests, one on trust and wording. Both returned GO with no P0 or P1.
  - Their P2 and P3 findings are fixed: the wording, the inline error over an older diff, independent reads, the coordinated error state and open-file re-read, and the duplicate App refresh.
  - The browse-race check stays timing-based (see Known limits).
- **Not run.** `package:dir` and `smoke:package`, because nothing in packaging or dependencies changed. The packaged app and the installer are not verified.

**Known limits**
- **Rendering assumption.** The empty-state sentence assumes the runtime's current exclusions. A runtime flag saying "paths were left out" would be more exact, but it is a protocol change and was not made.
- **Timing-dependent check.** The browse-during-refresh e2e check relies on timing: the folder click must land while Refresh's reads are still running. It cannot fail with the fix in place. On this machine it caught the old behaviour (the mutant failed), but a much faster machine could let the old code pass.
- **No timestamp.** One refresh is taken when an approval settles. A command whose outcome is `unknown` may still write later, and the tab does not say how old its snapshot is. The approval card and the banner carry the unknown state.

## Clear site data: the `browser.spec` wait, and pages that ask to stay — 26–27 October 2026

Task id `browser-clear-wait-20261026`. Two parts:
- a test-only fix for a flake;
- a main-process and renderer fix for clears that a page's `beforeunload` blocked.

No protocol, IPC channel, runtime, schema or dependency change. Nothing is dual-landed in C#, which has no browser host yet. What its host must do is under the second part.

- **The flake.** The persistence test failed in 2 of 3 full `pnpm test:e2e` runs on a busy machine. Both failures were at the clear assertion, which still read the seeded cookie, `localStorage` and IndexedDB values.
  - The test clicked Clear data and waited on `tabs.every(!attachedTaskId)`, which was already true. It then sent `navigate` while the clear was still in flight.
  - `clearSite` blanks each same-origin tab with an awaited `loadURL('about:blank')` before it clears storage. A navigation that starts during that load makes Electron reject it with `ERR_ABORTED (-3) loading '<the new URL>'`, so `clearSite` throws before it touches storage. That is the handler error the failing runs logged.
- **The fix.** The test now waits for three things before it navigates to a fresh document:
  - the confirmation to close, in the render that marks the panel busy;
  - the address bar to re-enable, since busy ends only after the clear resolves;
  - the tab to sit idle on `about:blank`.
- **Evidence.**
  - Sending `clearSite` and `navigate` together reproduces the logged error and the seeded values every time.
  - With `clearStorageData` delayed by 2 s in main, the previous spec fails 3 of 3 at the clear assertion and the new one passes 3 of 3.
  - The new spec passes 10 consecutive runs alongside a parallel `vitest run`. That load alone did not reproduce the old failure (the previous spec also passed 10 of 10), so the deterministic cases are the proof.
- **Product behaviour, checked.**
  - Clear site data reports success only after these resolve: `clearStorageData` (cookies, `localStorage`, IndexedDB, Cache Storage, service workers), `clearCache` and both flushes.
  - It does not reload; same-origin tabs stay on `about:blank`.
  - While it runs, the panel's busy state disables the address bar and Go, so the user's own panel cannot overtake it.
- **Pages that ask to stay (fixed 27 October).** A page that cancels `beforeunload` after the user has interacted with it made both clears fail with a raw `ERR_ABORTED` notice. Neither clear touched storage, though neither reported success.
  - Both clears now replace their tabs through one helper, `blank`. While its `loadURL('about:blank')` is pending, the tab's `will-prevent-unload` handler calls `preventDefault`, so the page cannot keep that one navigation from happening.
  - Manual navigation, back, forward and reload still honour a page's request to stay, with no prompt, as before.
  - The confirmations now say that open pages are replaced with a blank page and unsaved changes are discarded, because the clear overrides the page's own prompt.
  - **Test.** `site and profile clears replace a page that asks to stay` seeds a page, adds a cancelling `beforeunload` and clicks the page, then runs each clear through the panel.
    - Before the change it failed at the `about:blank` check, with the tab still on `/seed`.
    - After it, both clears blank the tab, and the next page reads no cookie, `localStorage` or IndexedDB value.
    - Each clear must also raise exactly one `beforeunload` dialog, so the test cannot pass on a page that never asked to stay. With the page's handler removed, it fails at that check.
    - Electron settles `beforeunload` before Playwright hears of the dialog, so Playwright's default dismissal fails the test with "No dialog is showing". The test records and dismisses dialogs itself and ignores that error.
    - An independent review (Sonnet, high, from its definition) returned GO with minor findings. It suggested the dialog check above, which was added.
    - Not tested: a tab attached to a chat, whose debugger has `Page` enabled. The test's own Playwright session also has `Page` enabled on the page, and the override works there.
  - **C# host.** When the WebView2 browser host is built, its clears must override the prompt in the same way, for their own blanking navigation only. With `AreDefaultScriptDialogsEnabled` off, that means calling `Accept()` on a `ScriptDialogOpening` of kind `Beforeunload`.
- **Still not changed.**
  - A navigation during the blanking still makes a clear fail with a raw `ERR_ABORTED` notice, with nothing cleared. Only the API can send one, since the panel is busy. A retry is safe.
  - Under artificial full CPU saturation (a busy loop per core), earlier steps of the persistence test timed out in 2 of 10 runs, at the inspector resize and the manual navigation after restart. Neither fix touches those steps.

## High contrast theme — 26 October 2026

The fifth step of the preset themes plan. Task id `ui-theme-contrast-20261026`. Renderer only. No protocol, IPC channel, runtime, provider, schema, dependency or main-process change.

Delivered:

- **The choice.** High contrast is a fourth theme in Settings: System, Light, Dark, High contrast.
  - It is in the closed list in `theme.ts`.
  - `theme-boot.js` restores it before the first paint.
  - System never resolves to it.
  - The helper text says it is a light theme with darker text and stronger borders, so it is not mistaken for a Windows contrast theme.
- **The theme** is one block of token values under `:root[data-theme="contrast"]`, inside `forced-colors: none`, so a Windows contrast theme still wins.
  - It is the themes round's reviewed design, ported unchanged: 148 tokens.
  - It adds `--placeholder-disabled`, which the base gained after that round. It aliases `--ink-muted` (7.6:1 on the disabled fill), because a disabled composer's placeholder is the only thing that explains why it is disabled.
- **What the theme does:**
  - Body ink is a near-black green, at 7:1 or more on every surface.
  - Borders, not tints, carry the structure: cards are 6.5:1 and controls 8.5:1 on the canvas.
  - Needs-you is one rust family, warning is amber and danger is crimson.
  - The focus ring is deep blue.
  - The rail stays dark, with brighter ink.
  - Every fill has its own white ink.
- **Compact** works with it, because the style carries no colour.

Validation:
- `themes.test.ts` checks the block strictly. Body inks must reach 7:1. Every other text, every control boundary, ring and mark, and the card, panel and popup borders must reach 4.5:1. The border rows are new and apply only to strict themes, because Light and Dark separate those regions by tone.
  - It also applies the rules every theme meets:
    - every literal Light token is restated;
    - needs-you, danger and warning are told apart;
    - focus rings stay out of the needs-you family;
    - the colour scheme matches the canvas;
    - the Retry button's scheme matches its box;
    - the block is wrapped in `forced-colors: none`;
    - Settings offers every block.
  - Each of 14 mutations fails a check. Four of them use values that pass Light's thresholds and fail only the strict ones; one is a card border at 3.4:1.
- `theme.test.ts` covers the closed list, System never resolving to High contrast, the first-paint script for a stored `contrast`, and every stored theme and style pair.
- `theme.spec.ts` (e2e) checks the following:
  - Settings offers four choices.
  - High contrast sets `data-theme` and the window underlay.
  - It ignores the Windows app mode.
  - It gives way to emulated forced colours. Unwrapping the block makes this fail.
  - It is restored before the first paint.
- Harness, at 125% display scaling. It covers the 27 app captures, the keyboard-focused tray, and the states, coverage, extras and dialog sheets:
  - At WCAG thresholds, the contrast, overflow and 24×24 target lists are empty for High contrast, High contrast with Compact, and High contrast with the Windows app mode dark.
  - At 7:1, with large text at 4.5:1, no text node in the 25 app captures falls below. Light has 602.
  - Under emulated forced colours, High contrast renders the same as Light: 27 of 29 captures are identical. The coordinated pair differs only by run state, and its inspector is identical.
  - With the Windows app mode dark, High contrast is unchanged, apart from isolated pixels and the coordinated run state.

Known limits:
- Two text nodes in High contrast fall below 7:1, both above 4.5:1:
  - the Retry button in the rail's error box, at 4.6:1. Its face is drawn by Chromium, not a token;
  - the rail's "+" glyph, at 5.5:1.
- Some lines stay below 4.5:1 on purpose:
  - Dividers are 2.8 to 3.9:1. They separate regions and do not bound a control.
  - The disabled-control border is 2.2 to 3.0:1, so a disabled control reads as disabled.
  - The 3px success stripes are 3.4 to 3.9:1 where they are drawn, beside the word that carries the state.
- Two pairs are told apart by their words, not by colour alone:
  - The primary fill (rust) and the danger fill (crimson) sit 30 degrees apart in hue, as designed. Approve and Reject also differ in style: a filled button against an outlined one.
  - APPROVED and EXECUTING share one neutral chip, as in Light.
- The Windows title bar and caption follow Windows, as they do for every theme.

Not verified: the packaged app; the installer.

## Compact style — 26 October 2026

The fourth step of the preset themes plan. Task id `ui-theme-compact-20261026`. Renderer only. No protocol, IPC channel, runtime, provider, schema, dependency or main-process change.

Delivered:

- **The choice.** Settings now has a Style group under Theme: Comfortable or Compact.
  - It is a closed list in `theme.ts`, kept in this viewer's `localStorage` under `foundry.style`. Anything missing, unknown or unreadable means Comfortable.
  - `theme-boot.js` sets `data-style` before the first paint, as it does `data-theme`.
  - Theme and style are independent, so any theme works with any style.
- **Compact** is one block of size and spacing token values under `:root[data-style="compact"]`. It has no selector, no colour, no `--target-min` and no ladder change.
  - It is not inside `forced-colors: none`, so it keeps its sizes under a Windows contrast theme.
  - It ports the themes round's design onto the role names from the normalisation.
  - Intentional differences from that design:
    - where merged roles had different Compact values, one value was chosen per role. For example the rail rows are 4px 8px, the button padding 4px 12px, and project task rows sit 1px apart rather than 0;
    - awaiting and decided cards share one padding, because emphasis must not change a card's geometry;
    - wide-layout fields are 4px apart, not 2px, so a multi-line value does not run into the next field.
- **Label-beside-value approval fields.** In Compact, approval fields put the label beside the value in a list at least 560px wide (the Focus tray, or a widened inspector). That keeps about 400px for the value, and the label aligns with the value's first line.
  - In a narrower list (the docked inspector) the fields stay stacked, so the label column never narrows the value column.
  - Long paths, commands and hashes still wrap anywhere, in both styles, and are never truncated.
  - The two lists that hold cards (`.approvals-panel` and `.approval-tray-cards`) are the size containers, not the cards, so a card is never its own stacking context.
  - In Comfortable the narrow values equal the wide ones, so nothing changes. Against the same build with the containers removed, 25 of the 27 captures match at tolerance 8. Two of those differ by one or two isolated pixels.
    - The two coordinated captures differ because the run moves on between captures: one approval was waiting in one capture and two in the other.
    - In the inspector, the tabs and the approval card both captures show are identical, apart from the count in the tab label.
    - The keyboard-focused Pending actions tray is pixel-identical, focused and blurred.
- **The rail.** Compact's rail is 240/224px. App reads the rail widths again when the style changes, and keeps the stored inspector width inside the new limits.

Measured at 125% display scaling, with Comfortable first and Compact second.
- The header and composer rows come from a plain chat. The Approve rows come from the demo command card.
- "In view" means the whole Approve button is inside its scrolling list. Otherwise the table gives how far its bottom edge sits below the list's visible edge, to within about 2px.
- Approve is 34px tall in Comfortable and 30px in Compact.

| | 1480×940 | 1000×680 |
|---|---|---|
| Task header | 120 → 73px | 172 → 129px |
| Composer | 85 → 47px | 85 → 47px |
| Approve, docked inspector | in view → in view | 109 → 14px below |
| Approve, Focus | 45px below → in view | 260 → 3px below |
| Inbox rail rows | 6 → 8 | 2 → 4 |

At 1000×680, whether Approve fits depends on the card's content. A path that wraps one more line moves it by about 16px. Neither style claims Approve stays in view there, so the list still scrolls.

In Focus, Compact lowers the transcript's minimum height while the Pending actions tray is open (96 to 72px). It also lets the tray take up to 68% of the window rather than 60%. The latest message can be clipped at 1000×680; the card carries the exact action.

Validation:
- `styles.test.ts` checks every style block:
  - it sets only size-role names, which catches names that no longer exist;
  - no colour, no `--target-min` and no ladder change;
  - under it, every control height stays at least 24px, every type role at least 11px, prose at least 14px and evidence at least 12px;
  - narrow approval fields stay stacked;
  - it sits at the top level of the stylesheet, so no `forced-colors: none`, `@media` or `@supports` wrapper can switch it off;
  - the Style list matches the blocks.

  Each check fails on a mutation of what it guards. The mutations are recorded in the verification notes.
- `theme.test.ts`:
  - the style list, the fallback and blocked storage;
  - the first-paint script for every stored style;
  - the theme and the style staying independent, for every stored pair in both Windows modes.
- `styles.test.ts` also checks:
  - every `[data-style]` in the stylesheet opens one of the blocks;
  - both card lists are size containers;
  - the narrow field tokens alias the wide ones;
  - the 560px rule sets the wide field layout.
- `style.spec.ts` (e2e):
  - the Style group offers two choices;
  - Compact and Dark apply together and survive a reload, from the first paint;
  - the inspector's End key and `aria-valuemax` follow Compact's 240px rail, and returning to Comfortable clamps the inspector to the wider rail's limit. Disabling the re-read fails this;
  - in the real stylesheet, a 900px list puts labels beside values and a 400px list stacks them;
  - Send is shorter than Comfortable's and stays inside an emulated 880px viewport;
  - the rail footer stays inside the window at 1000×680 and 200% zoom. It is measured once the viewport is 340 CSS px tall, before any viewport emulation;
  - an unknown stored style means Comfortable.
- Harness: the contrast, overflow and 24×24 target lists are empty for Compact, Compact on Dark and Compact under emulated Windows contrast, in all 27 captures and on the states sheet.

Known limits:
- 145 padding, margin and gap declarations outside the token blocks still use literal px values, so they keep Comfortable's spacing in Compact. Most are on secondary surfaces: assignment cards, browser chrome, the manage, automation and review dialogs, the Usage page, and the channel composer.
- Compact's one-line header, hanging transcript column and wider default inspector from the density round need markup or `layout.ts` changes. They are not included.
- `style.spec.ts` checks the rail footer at 1000×680 and 200% zoom without the upgrade banner that `orchestration.spec.ts` uses.
- Seen in review and left alone, because they are not Compact's own and the fix would change Comfortable too:
  - in Compact the header's status line can wrap with a trailing "·";
  - the Inbox row titles inherit the 16px button text in both styles;
  - Cancel task has no confirmation, and Compact puts it 6px from the other header buttons (8px in Comfortable);
  - under a Windows contrast theme, Approve and Reject both render as outlined buttons. The forced-colors rules that do this do not depend on the style. Only Compact was captured under emulated contrast, and the High contrast step covers this.

Not verified: the packaged app; the installer.

## Size and spacing tokens, normalised — 26 October 2026

The third step of the preset themes plan and the prerequisite for a Compact style. Task id `ui-theme-space-20261026`. Renderer only: `styles.css`, `layout.ts` and a few lines of `App.tsx`. No protocol, IPC channel, runtime, provider, schema, dependency or main-process change.

Delivered:

- **Every size and spacing value is a role token** (the style axis), folded into `styles.css` in place from the themes round's layer.
  - It is proven to change nothing on its own, against the previous stylesheet injected over the build:
    - all 2021 re-expressed declarations compute identically;
    - the 27 harness captures and the 6 states-sheet images match, apart from the coordinated demo, whose run state differs between captures.
  - The fold also added properties at today's values, such as the 24px clamp on the eight dense rows. The declaration check cannot compare these, because the old rules never set them; the captures cover them.
  - The prototype's separate padding for awaiting and decided approval cards was left out. Emphasis must not change a card's geometry, and a card that shrank once decided would move the next card's Approve under the pointer.
  - The prototype's size container on approval cards (`container: approval-card / inline-size`), its `@container` rule and six narrow-card tokens were also left out. Only a label-beside-value Compact layout needs them, and containment makes every card a stacking context, which the injected-stylesheet proof cannot exclude. The Compact change adds them back with its own captures, including the Focus tray's keyboard focus ring.
- **Normalised: a deliberate, reviewed change to the default look.**
  - Spacing roles sit on the 2, 4, 6, 8, 12, 16, 24 and 32px ladder. The two half steps joined the `--space-*` scale.
  - Roles that are one concept were merged, from 223 to 181 tokens.
  - How it was chosen:
    - two designers proposed a conservative map and a merge-heavy map;
    - three judges compared them on real renders at four sizes and preferred the conservative base, two to one;
    - the owner took that base, changed it per the judges' objections, and two verifiers checked the result.
  - What changes on screen:
    - the task header is 6px shorter at 1480×940 and 9px shorter at 200% zoom;
    - the composer is 4px shorter;
    - ordinary buttons are 2px smaller;
    - rail rows are slightly tighter, so the Inbox shows one more row.
  - What changes on the approval surfaces, all by 1 to 4px:
    - the approval banner and notices pad 8px instead of 9 to 10px;
    - the readiness note is 4px shorter;
    - an awaiting card is about 3px shorter;
    - field spacing goes from 9/3px to 8/4px;
    - the evidence block's margin and padding are 8px instead of 10 and 9px;
    - the privilege disclosure's inline padding is 8px instead of 9px;
    - the state badge's padding is 2px 6px instead of 2px 7px.

    Approve sits up to 5px higher or lower depending on the card above it, and is in view in the same captures as before.
  - What does not change:
    - Approve and Reject keep their exact size (78×34) and their 12px gap. `--pad-decision` stays off the ladder on purpose;
    - control heights, type sizes, widths and measures;
    - every pointer target is at least 24px;
    - the awaiting rule still sets only colour, border and ring.
  - Alignment:
    - at 950px wide and below (including 200% zoom), the task header now sits on the page lane with the composer, banner and notices; before, it was 12 to 24px inside it;
    - the readiness note's text lines up with the approval card text;
    - the Projects-mode status dot stays under its project label.
  - Merges were not taken where a Compact style would set the members differently: rail rows and inspector rows, the Usage section's margins, the compaction box, flat rows and bordered cards.
- **`layout.ts` takes the rail width from the tokens.** The inspector's maximum, `aria-valuemax`, the End key and the clamp of a stored width followed a hard-coded 270/236px rail.
  - App reads `--rail-w` and `--rail-w-narrow` once, at start. The tokens must be px lengths; anything else keeps the default.
  - A style that changes the rail at runtime has to read them again. That is for the Compact change.
- **The rail's Retry button reaches the 24px target floor** (it was about 20px).
- **The readiness note keeps each limit with its unit:** "50,000 files", "1 GiB" and "10,000 directories" use non-breaking spaces, so "1" and "GiB" no longer wrap apart. The words are unchanged.

Validation:
- `styles.test.ts`:
  - the size block is found and holds more than 150 tokens;
  - the 24px floor on every control height and on the eight dense rows, listed by name;
  - 11px for every type role and 14px for prose;
  - Approve and Reject keep their own padding, and the approval fields stay stacked by default;
  - every size token is in use, none holds a colour, and no declaration uses an undefined token.
- `layout.test.ts` ties the stylesheet's rail tokens to `DEFAULT_RAIL_WIDTHS`, requires every rail value in the stylesheet to be a px length, and checks the limits follow other widths.
- `inspector-width.spec.ts` (e2e): at 1480 and 1040px wide, the End key, `aria-valuemax` and a drag all stop at the same width, which leaves the conversation its 320px minimum.
- Every new guard fails on a mutation of what it checks.
- Harness: the contrast, overflow and 24×24 target lists are empty in all 27 captures and on the states sheet, before and after.

Known limits:
- 181 tokens, not the plan's estimate of about 150. The judges found the remaining merges would cross regions that a Compact style sets differently.
- About 215 spacing declarations on secondary surfaces keep literal values: the manage, automation and review dialogs, browser chrome, MCP and channel panels.
- In a window at most 950px wide and at most 720px tall, the narrow header rule wins, so the header's block padding is 16/16 rather than 16/12. The rule order is unchanged.
- For the Compact change:
  - `50-compact.css` is written against the old role names, 46 of which no longer exist; the review records the mapping;
  - some trust surfaces share generic roles: the state badge with the rail count chips (`--pad-badge`), and the approval banner with notices (`--pad-strip-y`). Compact should name them separately or review them explicitly;
  - handoff and integration evidence text and the "Read-only reconciliation" note are not on `--fs-evidence`.

Not verified: the packaged app; the installer.

## Preset themes: Foundry Dark and System — 26 October 2026

The second step of the preset themes plan, on top of `ui-theme-tokens-20261026`. Task id `ui-theme-presets-20261026`. No protocol, IPC channel, runtime, provider, schema or dependency change, and no main-process change beyond the underlay that step added.

Delivered:

- **The choice.** Settings opens with a Theme group: System, Light or Dark. These are radio buttons from a closed list (`theme.ts`); there is no colour or CSS setting.
  - The choice is kept in this viewer's `localStorage` under `foundry.theme`, like the inspector width. Anything missing, unknown or unreadable means Light.
  - System follows the Windows app mode through `matchMedia`, and keeps following it until another choice replaces it. `nativeTheme.themeSource` is never set, because it would also change how websites in the Browser pane render.
- **Before the first paint.** `public/theme-boot.js`, a classic script in the page head that the CSP allows as a same-origin file, sets `data-theme` before the bundle runs. The bundle alone painted first in 1 of 12 measured loads. `theme.ts` then re-applies the choice and writes the theme's `--canvas-deep` into `<meta name="theme-color">`, which the window takes as its underlay.
- **Foundry Dark.** One block of 146 token values under `:root[data-theme="dark"]`, inside `@media (forced-colors: none)`. It was designed in the themes round as warm graphite with the same meanings as Light:
  - needs-you is copper-orange, with danger a crimson 29 degrees away (CIEDE2000 23);
  - warnings are ochre and success a quiet green;
  - the focus ring is ice blue and the rail selection mark green.

  The needs-decision row's outline was raised to 3:1 for the pair rule added in the previous step.
- **Changed after independent review:**
  - Disabled fields have their own placeholder colour, `--placeholder-disabled`, at 4.5:1 or more on the disabled background in every theme. The composers explain themselves this way, for example "This task worktree is retired. Create a new task to continue.". In Light that text was 3.45:1 and is now 4.66:1; enabled placeholders keep their lighter grey.
  - Dark's placeholder is a neutral grey (4.82:1), as Light's is. The warm tone read as a value.
  - Dark states `--rail-error-scheme` itself instead of inheriting it.
  - The Theme legend uses the dialog's field-label style.
  - The helper text is tied to the group with `aria-describedby`. It now says the title bar follows Windows whatever you choose, and that a Windows contrast theme replaces these colours.

Validation:
- `themes.test.ts` checks Dark as it does Light: every literal colour and scheme token set, 67 pair rows, including the new disabled-placeholder row, the meaning rules and the wrapper. The settings list and the theme blocks must match.
- `theme.test.ts`: the closed list, the fallback, blocked storage, the System listener and its stop, and the underlay value check. It also runs the real first-paint script for every stored value, both Windows modes and blocked storage, and expects the theme the module would apply.
- `theme.spec.ts` (e2e):
  - the Theme group offers three choices;
  - Dark applies, colours the window underlay and survives a reload. `data-theme` is already dark when parsing ends, before the bundle runs;
  - System follows emulated Windows light and dark modes;
  - the arrow keys move the choice, and leaving System stops following Windows;
  - a stored value outside the list falls back to Light, from the first paint on.
- Harness on the built app:
  - Dark is clean (contrast, overflow and 24×24 targets) in all 27 captures and on the states sheet;
  - under emulated Windows contrast with the light app mode it is 0 pixels different from today.

Known limits:
- The Theme group sits in the dialog opened by "Model settings", the app's only settings surface.
- Under a Windows contrast theme the theme blocks do not apply. The window underlay therefore stays Light's canvas colour.
- The Dark chart colours were checked by the pair table, not rendered: the harness fixtures record no measured usage.

Not verified:
- a real Windows contrast theme;
- the Windows title bar. It follows the Windows app mode, so explicit Dark on a light Windows has a light caption;
- the packaged app;
- the installer.

## Theme tokens and Foundry Light corrections — 26 October 2026

Rudy asked for "a handful of preset themes and styles" rather than custom configuration, then asked to proceed with the recommendations of the themes, density and minimalism proposals. This is the first step of that plan: the colour layer every preset builds on, with today's light theme corrected. Task id `ui-theme-tokens-20261026`, branch `claude/ui-theme-tokens-20261026` from `main` at `68a6e8b`. The proposals, prototypes and evidence are under `.local/verification/ui-themes-20261026/` and `ui-theme-tokens-20261026/`. No protocol, IPC channel, runtime, provider, schema or dependency change. One main-process change: the window underlay (below). Nothing is dual-landed in C#; the WPF host will need the same underlay rule when it hosts the renderer.

Delivered:

- **Tokens.** Every colour in `styles.css` outside the token block (107 literal uses) now reads a semantic token. So do the seven SVG colours of `AssignmentGraph.tsx`, which now uses classes. Rules that mixed two roles read separate tokens: needs-you is no longer the warning tokens, the rail selection bar is no longer the needs-decision colour, and each fill has its own ink. The first commit (`ff85c63`) is a no-op at the harness tolerance of 8 levels per channel. It is not bit-identical: 36 literal uses were merged into the nearest token, by at most 7 levels. With the previous stylesheet injected over the new build, every harness capture (12 screens, 4 sizes) and the states and coverage sheets differ by 0 pixels at that tolerance, with three exceptions:
  - one anti-aliased pixel;
  - the coordinated demo, whose state advances between captures; its one comparable approval card is identical, but the agent tree was never compared pixel for pixel;
  - the agent graph, covered only by the coverage sheet.
- **Light corrections** (second commit). These change pixels on purpose. The token defaults now fix the defects the themes audit measured:
  - the focus rings are blue instead of needs-you terracotta;
  - needs-you is one terracotta family (also the coordinated agent tree's "awaiting approval" chip), warnings are ochre, and danger is crimson, told apart by 25 degrees of hue and CIEDE2000 16. Danger covers Reject, Cancel task, failed and unknown cards, errors, and the MCP "Runs without approval" chip, now on the danger tint;
  - chosen states (the pressed Activity filter, the chosen usage row, the resize handle and chart-bar hover) are brand green instead of needs-you terracotta;
  - the placeholder is 4.83:1 (was 4.49), agent-graph lines 3.34:1 (was 2.36), and the failed dot on a selected rail row 3.56:1 (was 2.75);
  - the rail's view buttons, action rows and search results have 3:1 borders (were 1.16 to 1.44:1), and the needs-decision row's outline is an ochre at 3.18 to 3.94:1 (was 2.26 to 2.8);
  - the rail's error box and buttons are dark rail surfaces, so the rail focus ring reaches 7.08:1 and 5.10:1 on them (was 2.15 and 1.65), and the Chromium-drawn Retry button follows them through `--rail-error-scheme`;
  - the rail's selection bar, tab underline and view-button bar are a mint selection mark, while the open task that needs a decision is marked amber in both rail lists;
  - the APPROVED and EXECUTING chips are neutral instead of the danger ink, beside their word.
- **Window underlay.** The window is created with Foundry Light's `--canvas-deep` (`#e8e2d4`) instead of `#142723`. `did-change-theme-color` on the UI window's own web contents applies the page's `<meta name="theme-color">` when it is a plain `#rrggbb` (`window-underlay.ts`). Browser pane tabs are separate web contents, so a website cannot set it.
- **Tests.** `themes.test.ts` checks Foundry Light, and every `:root[data-theme]` block that a later step adds, against:
  - the 66-row pair table: text at 4.5:1 and boundaries and rings at 3:1 on every surface they are drawn on (High contrast stricter);
  - the meaning rules: needs-you, danger and warning told apart by hue and CIEDE2000; focus and rail selection outside the needs-you family; the colour scheme matching the canvas; the Retry button's scheme matching its box;
  - completeness;
  - a ratchet: no hex, functional or named colour in rules or component markup; every theme block wrapped in `@media (forced-colors: none)`; the Windows contrast block last, with only the status dots opting out of it; one underlay colour across `index.html`, the main process and the token block.

  Each rule fails on a mutation of what it guards, and the CIEDE2000 maths matches the prototype checker (25 degrees and 16.1 for Light's accent and danger).

Pending decision, recorded in the test rather than changed: Light's secondary buttons keep no drawn edge. WCAG 1.4.11 does not require one on a labelled button, and outlining them belongs to the open minimalism decision.

Independent review: two read-only reviewers (security and trust, visual QA and refactor correctness, Sonnet high) both returned GO with no P0 or P1. Their P2 findings are fixed here:
- the agent "awaiting approval" chip and the "Runs without approval" chip had been left on mixed tokens;
- the needs-decision row's outline was too faint;
- the rail selection rule differed between the two rail lists;
- this entry's omissions.

Known limits, not changed:
- The skip link's focus ring is `--rail-focus` and reaches about 2:1 on the canvas when Focus mode hides the rail (it was about 2.5:1).
- `--warn-line` still borders the recovery notice in today's rust brown.
- The Windows status dots keep their author colours under a contrast theme (`forced-color-adjust: none`). The failed dot is 2.27:1 on a white forced canvas (was 2.94:1); the row's word carries the state.
- Neutral APPROVED and EXECUTING chips are told apart from an unstyled state only by their word.

Unverified:
- the look under a real Windows contrast theme (only emulated);
- `did-change-theme-color` in the packaged app (measured in a development build);
- the installer.

Next steps of the plan: the preference with Foundry Dark and System, then the size tokens with Compact, then High contrast, then the chosen minimalism and density look as Light's token values.

## Attention and Focus mode (renderer only) — 25 October 2026

Rudy asked to "minimize what's shown to help direct attention" and chose three layers: progressive-disclosure defaults, a manual Focus mode, and state-driven emphasis, with the hard rule that approvals, privilege warnings, unknown outcomes and errors are never hidden. Task id `ui-focus-20261025`, branch `claude/ui-focus-20261025` from `main` at `6e9d3e9`. Renderer and CSS only: no protocol, IPC bridge, main-process, runtime, provider, schema or dependency change, so nothing is dual-landed in C#. Focus is renderer state in session memory (not a preference or protocol field); the WPF host carries it with the React UI and must mirror `document.title` and leave Ctrl+Shift+F unbound. Security wording is unchanged; the Activity recovery notice's first clause gained singular grammar ("1 outcome needs inspection") and its recovery sentence is verbatim.

Method: a fresh tour of `main` (46 states at four sizes, aria snapshots, contrast and overflow scans), a six-lens roundtable (58 proposals merged into 31 items) and a seven-voter second round adding QA/e2e coupling. 25 items were accepted; extra shortcuts, narrow auto-Focus, a sidebar "More" fold, grouped coordinated chips, a skip link to pending actions and a Usage-tab fold were dropped. The roundtable record is under `.local/verification/ui-focus-20261025/roundtable/`.

Delivered: one derived needs-you model (`attention.ts`) from runtime counts that drives a never-dismissible banner covering unknown outcomes as well as decisions (now also in the coordinated child view), the `Inspect task` suffix, header state words with "context warning" / "budget warning" at the runtime's 80% thresholds, a "Publish (outcome unknown)" tab label, one announcement hook for both views, an App-level Inbox needs-decision count that shows "unavailable" rather than 0, and a "Needs you (N)" window title. One `useInspectorOverlay` hook replaces the two copies of the slide-over logic, and `data-inspector="overlay"` is the only source for its CSS. Focus mode (header toggle, Ctrl+Shift+F) hides the sidebar, makes the inspector the slide-over at any width and centres the conversation; in it the live approval cards render in a bounded "Pending actions" tray above the composer (same component and evidence; cards still waiting first, then unknown, running and settled ones, oldest first within each; counted summary, command-review limits beside them, one DOM copy), with the banner and slide-over path below the compact breakpoint. Counted native disclosures fold decided approvals (clean completions and rejections only; anything live, failed, revoked or anomalous stays open, and a card seen live stays put until a task switch), reference tool notes, coordinated Events and the Inbox's finished outcomes. The awaiting card gets a ring and filled badge, selection moves to a brand-green token, and the sidebar's green fills recede while the open task needs a decision.

Validation at `4f07535`: `pnpm test:e2e` 26/26, including the new `focus.spec.ts` and a coordinated Focus test; renderer unit tests 104/104. `pnpm check`: typecheck and lint pass; 778/779 tests pass, with the one failure in `packages/runtime/tests/git-operations.test.ts` (30 s timeout, then `EBUSY` removing a temporary worktree under parallel load). That file passes 29/29 when run alone, and this branch changes nothing under `packages/`. The after tour (201 screenshots) has 0 non-disabled contrast failures, as before, and no new overflow in any state shared with the before tour. Independent reviews: a branch code review (8 findings; 7 fixed, 1 accepted cost: a second action-center read per refresh), a trust/security-UX review (NO-GO for the tray hiding the command-review limits and for cards below its fold; GO after the fix), and a before/after visual and accessibility verification (its P1, Approve below the fold in the tray, and P2 items fixed).

Known limits: the slide-over is `aria-modal` without `inert`, as before at ≤950px, and now also in Focus; it covers the header's Cancel at wide widths. The unknown-publication estimate is conservative: `task.read` counts approvals and publications together, so it can over-report but never under-reports. Sidebar-local load errors are not visible while Focus hides the sidebar. Cards settled in the tray stay (below any still waiting) until a task switch or leaving Focus. The tray first shipped oldest first, which let a card decided earlier push a waiting one below the fold; a follow-up (`ui-tray-order-20261025`) orders it by what still needs a decision. Finished Inbox outcomes rarely fold, because any stopped task forces the group open. The Focus chip counts the open task too. Focused coordinated views refresh approvals on every coordinated event. Not verified: screen-reader output, forced-colors rendering, and 200%-zoom visuals (the tour's zoom2 capture is cropped; its scans are clean). Found but not changed: `tests/e2e/browser.spec.ts` asserts hidden native views with `contentView.children.slice(1)`, but the renderer is not a child view, so those assertions cannot fail; `focus.spec.ts` checks every child view instead.

## UI polish (renderer only) — 25 October 2026

Rudy asked for a UI deep-clean session: drive the app, hold an agent roundtable, implement the consensus. Task id `ui-polish-20261025`, branch `claude/ui-polish-improvements-c4cef3` from `main` at `bf7855a`. Renderer and CSS only: no protocol, IPC bridge, main-process, runtime, provider, schema or dependency change, so nothing is dual-landed in C#; the WPF host reuses these React components verbatim. Security disclosure wording is unchanged (restyled only).

Method: a scripted Playwright tour of 46 states at four sizes (1480×940, 1000×680, 1000×680 at 200% zoom, 1920×1080) with aria snapshots, an in-page WCAG contrast scan and an overflow scan, plus a keyboard-only pass. Six lens reviewers (visual, interaction, accessibility, trust/security UX, maintainability, power user) produced 80 findings; a seven-voter second round (adding QA/e2e coupling) accepted 52 merged items and dropped four (sticky approval bar, vocabulary sweep, header chips, two-column key/value panels).

Delivered: a `:root` token layer with AA-measured text and 3:1 UI tokens and an 11px type floor; visible low-emphasis controls (`.quiet` was 1.2:1); one tone-aware notice rendered in the open dialog or the main column (it was hidden behind modals and absent on Usage); inline approval-card failures; one shared `ApprovalCard` for both shells (coordinated cards had dropped Hash/Shell/Environment rows); prominent privilege and screening disclosures; outlined Reject/Cancel; humanised state words that keep the raw keyword; full hashes wherever authoritative; patch line classes; "Waiting for your approval" status, a review banner and real Approvals counts; Ctrl+Enter send (bare Enter stays a newline, and Enter in draft option fields no longer submits); per-task composer text; skip link, landmarks, named dialogs, a transcript log, aria-pressed tabs, a keyboard separator; a scoped usage chart that no longer paints unknown reservations as reported usage; header, sidebar, draft and coordinated-panel layouts that hold at the minimum size and 200% zoom; an MCP key pattern valid under Chromium's `v` flag (it was silently ignored); and a fixed `pnpm docs:screenshots` source/target mapping. Evidence and the roundtable record are under `.local/verification/ui-polish-20261025/`.

Measured: non-disabled WCAG text-contrast failures across the tour fell from 237 to 0; elements past the viewport fell from 422 to 0; the tour's console error is gone. `styles.test.ts` guards the token contrast, the font-size floor and every class hook, test id and accessible name the e2e specs locate. Independent reviews: a branch code review (eight findings: six fixed, two recorded as not changed), a trust/security-UX review (GO for the approval and disclosure surfaces; its three medium findings fixed, including Enter in a New chat option field implicitly sending), and a before/after visual and accessibility verification (mostly delivered; its remaining defects fixed). Not verified: real screen-reader output, forced-colors rendering and a repeat of the keyboard-only pass. Exact `pnpm check` and `pnpm test:e2e` results are in the PR.

## Reviewed single-file creation — scoped local expansion, 23 October 2026

After both post-merge PR56 workflows passed on `eb899fb`, Rudy explicitly approved a scoped migration-freeze exception for matching TypeScript/C# safe-file creation, the reviewed Windows primitive/bridge, and `write_file`'s null-as-create contract. Electron/TypeScript remains the shipping product. There is no native runtime adoption, cutover, database migration or new production dependency.

`write_file` can propose one absent UTF-8 file of at most 65,536 bytes inside an existing safe task-worktree directory. An existing file still requires its exact SHA-256; `replace_text` remains hash-required. The Create review shows the absent original, exact relative path, complete proposed text and resulting hash. Parents are never created and existing entries are never overwritten.

One C#5-compatible source is compiled into `Foundry.Platform` and embedded in the TypeScript bundle for a fixed PowerShell bridge. It anchors a local volume, opens each existing component relative to held directory handles without following reparse points, binds the complete parent identity chain into the review fingerprint, and revalidates it before atomic relative `FILE_CREATE`. It holds strict directory pins and the new exclusive file through bounded write, flush and content verification. The bridge sends bounded data through stdin under the existing kill-on-close Job supervisor; paths and content are never interpolated into executable source. This helper does not start or adopt the native runtime.

Execution intent remains durable before mutation. Successful creation itself is a mutation even for an empty file. Ambiguous post-create failures, lost/malformed replies and unverified process cleanup remain unknown; retained operations are never blindly retried or deleted. One-shot approval consumption remains effective after external deletion. Missing-file reconciliation cannot prove that creation never happened.

Final local validation passed: `pnpm check --maxWorkers=1 --bail=1` (105 files / 702 tests), the 65 Electron oracle tests and 698 metadata vectors, all 23 Electron workflows, the native Release build (zero warnings/errors) and full suite (8,250 passed, two existing environment skips), and `pnpm package:dir` plus `pnpm smoke:package`, including real packaged creation. A final source-binding-only addition for the extracted Windows job module passed the focused Electron command oracle, native source-binding check, typecheck and lint; application code was unchanged after the full check. All 102 oracle source bindings match. Compiled PDB checksums bind all 11 changed native source/test files, and the packaged runtime's embedded primitive and unpacked supervisor match the reviewed sources.

Independent filesystem/security source review found no remaining actionable defects after correcting and reproducing the prelaunch-error outcome classification. Exact candidate, review, validation and package-custody evidence is retained under `.local/safe-file-creation/`. All fixtures use isolated repositories and application data. Unsupported volume/identity observations refuse closed; live removable-device/ReFS, installer/signing, providers and deployment remain separate qualification gates.

## Command review for installed dependencies — local expansion, 23 October 2026

Rudy approved a scoped exception to the migration feature freeze for matching TypeScript and C# command-fingerprinting changes. The shipping product remains Electron/TypeScript; this does not authorize native cutover, adoption, a schema/protocol change, or another feature expansion.

The old 10,000-file / 64 MiB bounds rejected an isolated frozen-install checkout containing 15,237 regular files and 280,793,930 bytes (about 268 MiB), plus 3,015 directories and 1,368 links. Both command runners now stream full regular-file contents outside `.git` in 64 KiB chunks, including ignored dependencies, with bounded admission at 50,000 regular files, 1 GiB aggregate content, and 10,000 directories or links. The TypeScript directory/link bound now matches the existing native bound. No ignored regular-file dependency is silently omitted, and no metadata cache substitutes for its bytes. Read growth, shortening, or changed file observations refuse the scan. Native hashing uses its existing safe-handle primitive with a dedicated read-only share mode that refuses an open writer and prevents writes or replacement while each file is being read. TypeScript instead checks the opened and named file's identity, size and timestamps around the bounded read. This native difference does not turn either whole-tree scan into an atomic snapshot.

Preparation retains the complete fingerprint; execution still consumes its one-shot capability and recomputes the full fingerprint before launch. The UI describes the limits before Send and in Approvals without claiming a live repository assessment. These scans observe filesystem state; they are not an atomic snapshot, filesystem isolation, or a guarantee against every same-user filesystem race. Task admission separately retains its 5,000 tracked-path Git filter-inspection bound. This expansion specifically supports larger installed dependency/output trees within an otherwise admissible repository.

Regressions use isolated synthetic repositories, including ignored trees above both old limits and same-size executable dependency changes after review. Generated P2 behavioral evidence is recorded under Electron's own pinned Node. Required local validation and independent review evidence are retained under `.local/repository-readiness/`; live providers, signing, installation and hosted CI remain separate gates.

## Coordinated handoff report — local expansion, 23 October 2026

Rudy selected a coordinated handoff/export as the first expansion after remediation PR54 merged. This increment starts from `main` at `cf2ccab` on the private `codex/coordinator-handoff-20261023` branch. It is a renderer-only metadata report using the existing `orchestration.get` read; protocol/runtime/DB contracts, execution permissions, native migration behavior and coordinated publication gates are unchanged.

The Handoff inspector panel shows the full branch, commit, tree and validation reference, then re-fetches current state on every download. Export requires recorded/current completion, a terminal successful uncancelled coordinator, terminal children, complete bounded metadata and the latest combined validation on that branch with a clean tree, zero exit and verified cleanup. It refuses stale/dirty/unknown state, missing or failed evidence and failed refresh. Valid superseded/failed historical runs and resolved conflict continuations do not by themselves prevent export.

The JSON uses a positive metadata whitelist: Git object IDs, task/result/integration references and validation status. It omits commands, working paths, credentials, patches, file contents, transcript text, approval payloads and continuation state. It contains no Git objects and grants no execution/publication authority. This is a fresh observed snapshot, not an atomic seal of the database and repository; subsequent changes require fresh review. Browser download uses a fixed-format UUID filename and JSON MIME type. Tests intercept download into isolated temporary storage.

Final local validation passed: `pnpm check --maxWorkers=1` (typecheck, lint, 99 files / 642 tests) and `pnpm test:e2e` (22 tests). The focused real-download workflow and 21 metadata regressions passed; an independent hash-bound security/integration review found no actionable defects. Evidence is retained under `.local/coordinator-handoff/`. This local feature does not qualify hosted CI, live providers, signing, installation, native cutover or release.

## Audit remediation — 23 October 2026

Scope: confirmed findings A01–A10 from the local application audit of `12773c7`, rechecked against current `main` at `ce73c53`. Implementation is isolated on `codex/audit-remediation-20261023`; feature expansion, publication, migration/adoption of real data, signing and main-branch integration are outside this change.

- **A01/A02, MCP cancellation and uncertain outcomes:** malformed, oversized and invalid JSON-RPC frames after dispatch retain an unknown outcome. Cancelling a dispatched call stops its supervised shared session and awaits cleanup; affected concurrent calls remain unknown. A cancelled pre-dispatch call does not stop another task's server. Replacement sessions wait for the previous stop, and missing cleanup evidence remains visible. Regressions include actual hosted stdio tools, delayed effects, descendants, shared callers and failure before dispatch.
- **A03, coordinator transcript:** already implemented on current main. Added coverage for the actual persisted user/assistant messages, child navigation and restart rather than duplicating upstream UI.
- **A04, credential restoration:** the private main-to-runtime credential frame distinguishes initial endpoint-bound vault restoration from replacement. Restoration preserves stored qualification; a different initialized secret or stale binding is refused. Replacement durably invalidates qualification before adopting the new secret and before main writes its encrypted vault. Database-write failure and same-secret retry are covered. The fix and private frame validation are present in both TypeScript and C#; it adds no public RPC or database migration.
- **A05/A06, coordinated controls:** selected-agent usage and manual compaction are available, as are explicit clean terminal root/child retirement and read-only reconciliation of unknown file edits. Aggregate root usage is distinguished from selected-agent context. Existing runtime gates remain authoritative; coordinated commit/push and automatic replay remain prohibited.
- **A07, qualification fidelity:** the developer qualifier loads the production provider adapters through a narrow in-memory build with configuration/env/public discovery disabled. It injects transport instead of maintaining independent request and stream parsers. Offline fixtures cover invalid authoritative output, continuation, refusal, malformed events, usage and cancellation.
- **A08, dependency patches:** Electron 44.5.0, Vite 7.3.7, Vitest 5.0.3 and resolved source-map-js 1.2.2. Electron's actual Node remains 24.21.0, matching `.node-version`. One disputed, unpatched `http-cache-semantics` advisory remains on the packaging dependency path; it is neither suppressed nor presented as a clean audit.
- **A09, installation evidence:** already corrected upstream in `docs/release-evidence.md`. Actual clean-profile installation remains open; the static verifier does not perform installation, launch or uninstall.
- **A10, completion evidence:** a retained completion preserves its timestamp while current unreadable/changed/unknown worktree state exposes blockers. The UI labels historical completion separately from current verification, including after retirement.

### Migration parity and validation custody

The shipping product remains Electron/TypeScript. Credential restoration/replacement is dual-landed in `DevelopmentChat` and the native private-frame validator. The native provider already rejects missing authoritative Responses output. Native coordination and MCP execution are still explicitly unavailable, so this change does not introduce those migration features or claim parity for them.

The additive private credential-frame metadata and generated C# model were regenerated from their TypeScript schemas. The affected P2 corpora were generated under Electron's own pinned Node; their behavioral payloads are unchanged and only their source seals changed. No fixture database or existing user data was migrated.

Final sequential validation passed: `pnpm check --maxWorkers=1` (typecheck, lint, 98 files / 621 tests), `pnpm test:e2e` (22 tests), locked native restore, Release build with zero warnings/errors, native tests (8,181 successes / two environment-dependent skips), `pnpm package:dir` and `pnpm smoke:package`. Focused regressions, initial failures, independent security/integration reviews and exact package hashes are retained under `.local/audit-remediation/`. Source, local tests, package custody, live deployment qualification, signing and clean installation remain separate evidence classes.

## WPF + WebView2 migration — P1 privately qualified; P2 in progress, integration held

Recorded 8 October 2026. The [migration plan](wpf-webview2-migration.md) replaces Electron and Node with three parts, delivered in a single cutover:
- a WPF host on .NET 10;
- WebView2 hosting the existing React UI;
- a C# runtime.

**No product behavior has moved.** The Electron application and the TypeScript runtime remain the product and the behavioral authority.

P0 deliverables so far:
- The approved plan (#12).
- The .NET solution skeleton (`Foundry.slnx`): the seven projects of the plan's layout, with placeholder entry points that exit non-zero; `global.json` (SDK 10.0.300, no roll-forward); central package management; lock files restored in locked mode in CI; nuget.org-only source mapping; NuGet audit with warnings as errors.
- Culture-sensitive string analyzers (CA1304, CA1305, CA1309, CA1310, CA1311) as errors.
- `BannedSymbols.txt` enforcing the runtime loop model (41 entries) and, since S7, `BannedSymbols.Launch.txt` in every product project, so processes launch only through `JobProcess` (2 entries). Each entry was shown to fire with a temporary probe.
- `Foundry.Architecture.Tests` enforcing the dependency graph and trust boundaries. Injected violations were shown to fail.
- The `.NET build` workflow: locked restore, build with warnings as errors, and test on every pull request.
- Golden vectors (`tests/golden`) that pin TypeScript behavior for the port: `JSON.stringify` edges and hashes, both profile fingerprints, UTF-8-ordered handoff manifests, schedule gaps and folds, redaction regex semantics, and MCP admission. The RPC corpus covers 99 schemas (RPC methods, bridge channels and non-RPC frames) with 4,149 seeded and mutated cases and zod's verdicts, plus 15 wire-level parser cases. The unit tests fail on drift. `scripts/golden-path-key.mjs` mirrors `pathKey` for machine-local cross-language checks and is proven equal to the runtime's.

- Fixture databases (`tests/fixtures/databases`): six real databases written by each schema era’s own runtime (`f75d1ed`, `2b42bb7`, `cdec0a3`, `0212982`, current main), driven over stdio through one shared profile and each era’s confirmed upgrade, so later fixtures hold every earlier era’s row shapes. They include an abruptly stopped v5 with an uncheckpointed WAL and a response in flight. Each fixture’s `expected-after-open.json` pins what the current `Store` changes on open (the `user_version` stamp, the DDL that re-runs on every open, and `recover()`’s transitions); the unit tests keep it current. Paths come from a name-free scratch root, and the generator rejects any output containing the user name or profile path.

- Spike S8a (SQLite parity), adopted. Microsoft.Data.Sqlite 10.0.12 (SQLite 3.53.3) returns better-sqlite3 13.0.3's (SQLite 3.53.4) results for every recorded query on all six fixtures. That includes the real search SQL, FTS5, both expression and descending indexes, and JSON, number and date functions. A live WAL database backs up and verifies, and read-only opens see WAL pages. `tests/Foundry.Runtime.Tests` keeps the parity under test; the decision is recorded in the plan.

- Spike S8b (strict JSON reader), decided. Both host boundaries reject non-canonical integers (`4.0`, `4e0`), lone-surrogate escapes and a leading BOM, in addition to the plan's duplicate-key, depth and unknown-property rules. `tests/Foundry.Protocol.Tests` proves all 15 wire cases on the bridge-string and stdio-byte paths. `rpc-wire.json` now records a decision for every case.

- Spike S7 (Win32 primitives), adopted. `Foundry.Platform` now holds `JobProcess`, `FinalPath`, `ProtectedDirectory` and `ProtectedSecret` on hand-written `LibraryImport` interop. `tests/Foundry.Platform.Tests` (62 tests) proves them:
  - **Process trees.** The TypeScript process-cleanup scenarios pass natively. Killing a real job owner reclaims its nested tree. A decoy inheritable handle stays out of the child, and concurrent launches never share pipe ends. Because a redirected `Process.Start` does inherit that handle, all product code now bans `System.Diagnostics.Process`.
  - **Path keys.** `FinalPath` matches Node 24's `pathKey` across a real-tree corpus. The spike found two Node behaviors that the port now reproduces: realpath namespacing (trailing dots, trailing spaces and long paths) and full-case lowercasing (`İ` and the final sigma). The lowercase ships as Electron 44's Unicode 17 tables, so keys do not move with Windows' older ICU. Scope checks get a no-fallback `TryResolve`.
  - **Protected directories.** The on-disk descriptor equals the PowerShell result.
  - **DPAPI writes.** Entropy must be a digest, and the write-through atomic write keeps the old file on failure.

  The independent security review (Sonnet, high, from its definition) returned a conditional GO. Every condition is addressed and covered by tests.

  S7 and S8, the two spikes that gate P1 code, are now both complete.

- The stdio trace recorder (`scripts/runtime-trace.mjs`) taps a driver's runtime child from inside the driver. It records both directions, stderr and exit as JSON lines, never writes credential values, never throws into or delays the driver, and provides a normalizer and a `compare` command for differential runs.
  - `pnpm smoke:package` records each runtime launch when `FOUNDRY_RUNTIME_TRACE` is set. Traced and untraced runs pass against the packaged runtime.
  - Two traced runs diverge after 139 normalized records: polls observe racing states, concurrent children interleave events, and the event count varies. P2's differential traces therefore need deterministic scenarios; the plan records this.
  - The independent review (Sonnet, high, from its definition) returned NO-GO on the first version. The findings were redaction gaps for malformed, batched and encoded frames; tap failures that could reach the driver; and a listener that changed when the driver read. All are fixed. Tests inject each case, and mutations show that each test fails without its fix.

- The zod-free limits module (`packages/protocol/src/limits.ts`). It imports nothing and holds the three values the renderer used from the protocol package: `CHANNEL_LIMITS`, `ORCHESTRATION_LIMITS` and `supportedEfforts`. The zod modules build on it and re-export it, so the package's public API is unchanged.
  - An ESLint rule keeps every other renderer import from the protocol type-only.
  - The renderer bundle drops from 1,503,829 to 1,289,682 bytes and holds no zod.
  - The golden RPC corpus shows every schema verdict unchanged. All 21 Electron E2E tests pass.

- Spike S1 (publish layout), decided.
  - The runtime starts without WPF.
  - Two self-contained apphosts can share a folder, but their closures disagree on two files: a facade versus WPF's `WindowsBase.dll`, and the `ProtectedData` package versus WindowsDesktop's copy. Publish's newest-file copy then leaves each app a file its deps.json did not select.
  - P4 therefore publishes the runtime into its own subfolder: 34 MB more zipped (94 MB in total) for no reconciliation. The plan records sizes and start-up times.

- Spike S10 (exclusion, restore, installer), decided.
  - **Exclusion signals.** The `FileShare.None` probe reads the database, WAL and shared memory as busy while an idle TypeScript runtime holds them, without changing them. Electron's Chromium `lockfile` is held while the app runs, so both signals are verified.
  - **Restore hazard.** Copying a backup over a database that a connection still holds succeeds and is then silently undone by that connection's close-time checkpoint, so the rollback runbook now restores by rename. The rename is refused while any holder exists.
  - **Installer.** The `windows-2025` runner compiles a per-user Inno Setup installer with no install step.

- Spike S2 (bridge and lock-down), decided. `tests/Foundry.WebView2.Tests` runs a real WebView2 serving the `foundry-app` scheme with header CSP, and a prototype of the plan's gate.
  - **Gate.** The prototype accepts the app document's well-formed messages and rejects exactly the oversized, malformed, non-string and foreign-origin ones. WebView2 delivers oversized strings whole, so the host enforces the 1 MiB cap.
  - **CSP.** The header blocks `eval`, inline script and `fetch`.
  - **Frames and popups.** Frames never reach the host's message handler, and a handled `NewWindowRequested` opens nothing.
  - **Lock-down.** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` opens a debug port for a non-elevated host, and clearing the five variables closes it. Elevated processes, including the CI runner's, ignore both the variable and an HKCU policy. The artifact audit's debug-port check must therefore launch non-elevated; the plan records this.

- Spike S9 (CI runner and CDP), decided. The `windows-2025` runner hosts WebView2, and Playwright's `connectOverCDP` attaches to two environments through API-only debug ports. The .NET workflow now installs the locked Node dependencies, so this attach runs on every pull request.

- Spike S5 (integrated-browser parity), decided. `BrowserParityTests` (12 tests) reproduces against real loopback origins what both `browser.spec` scenarios and `browser-manager.ts` rely on:
  - persistence across a restart, on the named profile;
  - popup adoption with its opener, configured like any tab;
  - per-origin and whole-profile clearing;
  - `SNAPSHOT_SCRIPT` run verbatim in an isolated world;
  - file-chooser interception and the selected-file precheck;
  - held and cancelled downloads;
  - certificate and basic-authentication refusal;
  - upload blocking for documents, dedicated and service workers, beacons and redirected requests.

  WebView2 differences changed the plan's browser design (section 6):
  - **Downloads.** Held downloads are written early, so they are staged in a host folder that is swept at startup.
  - **Redirects.** A cancelled redirect has already sent its request, so the navigation guard runs in a request filter.
  - **Shared workers.** Their requests cannot be filtered: the filter kind stalls them after a reload. The integrated browser runs without shared workers, with target discovery as a backstop.
  - **Upload bodies.** WebView2 does not reveal whether a body came from a file or a blob. While attached, every body without a text-like type is therefore blocked. This is a heuristic, because the page chooses the type. A raw page-held file or blob sent as text remains a residual, which Rudy accepted.
  - **`chrome.webview`.** It exists in every page and frame, so the negative test checks that nothing posted through it reaches the host.

  The independent security review (Sonnet, high, from its definition) returned NO-GO on the first version. It found overstated upload and shared-worker claims and several Electron guards the plan had not carried over. It returned GO on the fixes, and its two remaining recommendations are applied:
  - the body rule is described as a heuristic;
  - attach confirms that shared workers are absent in every frame.

  Section 6's prescriptions that S5 left untested are listed among the plan's security tests.

- Run-ready harnesses for the three host spikes that Rudy runs himself ([docs/spikes](spikes/)). None of them changes a system setting.
  - **S3 (tab bounds).** `tests/Foundry.Spikes.BrowserSurface` measures on screen while Rudy switches display scaling. Its arithmetic and pixel classification are unit-tested.
    - A preview at 100%, with 125 to 200% simulated, shows exact placement, re-synced by the host on its own.
    - It also shows the UI's whole-pixel bounds missing near-worst fractional layouts by up to zoom × scale: 4 px at 200% and zoom 2.
    - Rudy decided on 9 October 2026 not to run S3 (see Next).
  - **S4 (input ladder).** The same app implements section 6's five-layer ladder as the subject of a manual test script; nothing generates input.
    - The test page has a same-origin and a cross-site frame.
    - Detach is judged by when the agent last changed the page.
    - Its self-check passed.
  - **S6 (toasts).** `tests/Foundry.Spikes.Toast` and `Run-S6.ps1` test the unzipped exe and a per-user Inno Setup install, then remove the registration and the install and verify that nothing is left. CI compiled the installer.
  - **Reviews.** Independent reviews of security and of test validity reshaped all three. After its findings were fixed, the security review gave GO for running S6 on Rudy's machine. The test-validity review's findings are all resolved.

Next, as Rudy decided on 9 October 2026:
- **S3: decided without a run, by Rudy's decision.**
  - The preview is S3's only evidence.
  - Rudy accepted the UI's whole-pixel inset with no protocol change. The criterion is restated as "within the UI's whole-pixel rounding, never over the UI".
  - P3's exit gate checks it with `browser.spec` at 100/150/200% DPI and zoom 2.
- **S4: desktop run completed 11 October 2026; tested input classes passed; accepted by Rudy with documented gaps on 12 October 2026.** The [recording sheet, raw results and cleanup](spikes/results/s4-20261011-073210/README.md) retain 19 takeovers: worst detach 16.0594 ms; zero attached input/hover events, breaches, unknown counts, page state changes or late agent effects; all restores succeeded. Physical clicks in the page and both frames, right/middle/side buttons, vertical/Ctrl/horizontal wheel, double-click, OSK text/emoji/clipboard, hover, external file/link drags, focus checks, move/resize edges and Take control passed the identified trials. Rudy confirmed normal Manual typing, buttons, scrolling and focus afterward. Keyboard chords were observed blocked in the earlier partial run, which later had an inactive agent and a shutdown exception; that limitation is preserved separately. Maximize/restore edge reports conflict with live readback and remain **inconclusive**. IME, voice, touchpad, touch, pen, external text drag, Windows+D and UIA are **not tested**. Final summary saved; independent checks found no spike processes, temporary spike profiles or loopback listener. Rudy's acceptance below resolves this run's disposition without invoking decision 7; no main integration authorized.
- **S6: desktop run completed 11 October 2026; activation inconclusive.** The [results and cleanup evidence](spikes/results/s6-20261011-063102/README.md) preserve the generated summary, both phase JSONL files, installer/uninstaller logs and console transcript. Installed Notification Center activation passed (one valid trial; behind another window, matching arguments, foreground after 800 ms), agreeing with Rudy. Steps 1–2 in both phases timed out without activation; these are inconclusive, not observed foreground failures. Unzipped step 3 has conflicting evidence: Rudy observed foreground activation, but no activation event was recorded. Taskbar flash was observed in both phases. After app closure, Rudy reported “clicked it and codex app flashed” (unzipped) and “clicked it; nothing happened” (installed); neither phase recorded a spike restart. Runner cleanup and independent residue checks passed; Rudy confirmed the spike was absent from Windows Settings → System → Notifications. Rudy's subsequent acceptance is recorded below; the measured limitations remain unchanged.

**S6 disposition — Rudy, 11 October 2026:** accepts the current toast/notification behavior without further retest or fallback; he will handle Windows Do not disturb. This resolves the S6 human decision while retaining the inconclusive measured trials and conflicting observation above. No COM-activator exploration is required by this acceptance.

**S4 disposition — Rudy, 12 October 2026:** “I accept S4 with the documented gaps.” This accepts the limited keyboard evidence, inconclusive maximize/restore boundary trials, and named untested classes. It resolves the S4 human decision; no additional retest or decision-7 fallback is required by this acceptance. Raw measurements and gaps remain unchanged.

With S3, S4 and S6 decided and the other spike outcomes recorded, P0's documented spike exit gates are resolved. Next is P1 **Contract & platform**: protocol corpus parity, the runtime loop, the Store and `workspace.summary`, building on the S7 platform primitives. P1 must prove full corpus agreement, identical normalized fixture dumps and structure, and green platform security tests, with independent security/data review where required. Re-baseline the migration schedule after P0. The local evidence/decision changes still require their review and authorized main integration; this acceptance authorizes neither integration nor real-data adoption.

These program rules hold until the P5 cutover:
- Protocol and runtime features are frozen, except the planned P4 deltas: adoption RPCs and removal of the JavaScript script language.
- Security and data-loss fixes land in both implementations and are listed below.
- The .NET runtime never opens the real data directory before adoption.

P5 cutover readiness. These stay open until the cutover decides them or a later slice closes them (Rudy, 18 October 2026, chose to keep the list here):
- **External profiles and saved MCP servers** (P2.4c, security review I3). Under decision 2, main loads credentials before `profile.probe` and `task.start`, so anyone with saved MCP servers cannot use an external profile. This holds until the MCP slice lifts it.
- **A send before the credential returns** (P2.4d, data review L1). Credentials live in memory, but verification persists. After a restart, a send made before the host sends the credential again is admitted, then fails with its reservation charged. TypeScript behaves the same, and the native port keeps it.
- **Live qualification of `profile.probe`** against real deployments. This is Rudy's operator gate. He decided on 19 October 2026 that it runs once, during the P4 rehearsal, against the packaged candidate; he names the deployments and a spend cap then. No routine suite makes a live or paid call.

Dual-landed fixes:
- **Saved-project/preference transition atomicity and failed-delivery admission** (13 October 2026). Independent P2 data review found that TypeScript saved these records and inserted their events in separate commits. Both implementations now commit each mutation and event together and notify afterward. Event insertion failure rolls back the state; notification failure retains the authoritative commit and closes admission to retries. Security re-review additionally required stopping independent orchestration and automation on delivery failure: TypeScript closes both synchronously and rechecks closing after awaited Git-state/pin validation before a new child or script launch. C# has no orchestration/script execution handler yet and denies these operations before mutation; those future ports must retain these guards. Never-launched scripts remain queued for safe recovery, and already-admitted work keeps conservative intent recovery. This is a data-integrity/lifecycle correction under the dual-landed-fix rule, not a feature expansion.
- **Fractional usage-trend date bounds** (13 October 2026). Rudy explicitly authorized correcting both runtimes after independent security review found that lexical UTC timestamp comparisons rejected `.1Z`–`.12Z` and excluded equivalent `.100Z` records. Both local implementations now compare exact instant keys, preserving arbitrary fractional precision and inclusive endpoints; SQL retains an indexable whole-second candidate window. No stored rows, keys, schema or API were rewritten. The original failing observations are retained in `test-results/p2-usage-trend-fraction-before.json`. Final validation and independent review are recorded below; external publication remains held.
- **Accepting an 8.3 or case spelling of an approved project folder** (16 October 2026).
  - **The defect.** Repository admission v2, merged in #32, compared the canonical real path with the raw approved path. Project-channel admission falls back to `task.projectPath`, which `task.create` stores exactly as supplied. So a task without a complete identity binding whose path used an 8.3 short name was refused with "The saved folder now resolves to a different location."
  - **How it showed up.** Main's Portable Windows CI failed in `tests/integration/usage.test.ts`, because the runner's `TEMP` is an 8.3 spelling (`RUNNER~1`). The failure reproduced locally with a short `TEMP`.
  - **The fix.** `resolveLocalPath` accepts an approved spelling that differs from the canonical path only when that spelling is link-free and is the same folder. Compared component by component with the canonical path, it must have the same drive root and the same depth, and every component must be a non-link with the same file identity (volume and file index from `lstat`). A candidate that reached the approved folder through an alias is still accepted, as before. A replaced approved folder (now a link) or a different folder is still refused.
  - **Fixtures fixed too.** Hosted runners exposed three more fixture problems under an 8.3 `TEMP`. `folder-admission` saved raw scratch paths as projects, and the `p1/summary` and `workspace-pages` corpus fixtures canonicalized with JavaScript `realpathSync`, which keeps 8.3 spellings. They now use native realpath, as production `project.add` does. The older `canonicalPath(x) === x` checks for saved projects are unchanged.
  - **Still refused:** subst drives, junctions and different folders. Node reports a volume mount point as a directory, so a spelling through the same mount folder is accepted; a different mount folder, or the mounted volume's own drive letter, is refused.
  - **Native side.** When this was written, C# had no approved-path comparison. The requirement: avoid this defect, and do not copy the lowercased key equality, which in a case-sensitive directory can treat two folders as one; compare 128-bit volume and file identities per component. P2.2 meets it with `RepositoryPaths.SameFolder` (see P2.2c), which compares the FileIdInfo identity of every component of both chains and refuses any reparse point.
- **Refusing a planted hook in the app-owned Git hooks folder** (H1, 16 October 2026).
  - **The defect.** The repository and Git-operations runners point `core.hooksPath` at `<worktree base>\.empty-git-hooks`, but nothing checked that the folder stayed empty. A file written there, for example by an approved command running with the user's privileges, was then run by later app Git operations without approval: `post-commit` despite `--no-verify`, `post-checkout`, `reference-transaction`.
  - **Found and fixed natively first.** The P2.2 native review found it, and the native half landed with P2.2 (#36). See its H1 entry under P2.2e for the native guard, which uses the same messages.
  - **The TypeScript fix.** Both runners (`repository.ts` and `git-operations.ts`) now require the folder to be absent or a real, empty directory, through `assertNoGitHooks`:
    - **Before every launch:** the check is refused before any mutation. For worktree creation the outcome stays "none".
    - **After every exit:** the call fails even if Git succeeded, and callers keep their existing conservative outcome classification. This is best-effort detection, not prevention: a hook that deletes itself evades it.
    - **Refusals:** a link at that path is refused, even one that points to an empty folder. The refusal names the folder to inspect.
  - **Pre-approval worktree state.** Its independent review found the same class in the `command-runner` worktree-state check that runs before approval. It used an empty `core.hooksPath`, which Git resolves to the drive root, and `git status` runs `post-index-change`. It now points `core.hooksPath` at a path below the verified `git.exe`. That is a regular file, so no hook can exist there.
  - **Tests.** Regression tests plant real hooks and prove that neither the commit nor the worktree creation runs them, that a hook planted while Git runs fails the call, and that a hooks path below a file runs nothing where a directory hook would run.
- **Refusing network-share paths from the renderer** (plan decision 8). Landed in the TypeScript runtime on 8 October 2026; the C# runtime takes the same test cases when it is ported.
  - **The exposure:** a compromised renderer could make Windows send the user's NTLM credentials to any server it named.
  - **Inputs now refused:** UNC, device and NT-namespace paths given to `project.add`, `task.create`, a hook's working directory, or an MCP server's command, working directory or absolute arguments. The check runs before any filesystem call.
  - **Mapped drives:** a project whose canonical path is a network drive is refused.
  - **Saved before the fix:** a project or task saved on a share is reported unavailable and never probed, and Git operations on it are refused. Hooks and MCP servers saved with network paths are refused at launch.
  - **Review:** the independent security review (Sonnet, high, from its definition) returned GO. Its follow-ups are applied: a spy proves no share is resolved before the check, and saved paths are no longer probed. Removing any one of the 13 checks makes a test fail.
- **Publication hardening from the review of #36 and the push allowlist** (17 October 2026). Native fixed these first: the P2.2e "Codex review of #36" fixes are on main, and the push-configuration and remote checks came with #37 (merged as `7df623a`, whose tree is `fb2a15e`, the native head this port was made from). The shipping TypeScript runtime now matches them, with native's messages (`repository.ts`, `workspace-operations.ts`, `store.ts`):
  - **Commit.** Both endpoints of a rename or copy in the status listing are screened for secret-named paths before staging, and the staged paths again without rename detection.
  - **Task worktree.** Commit and push require the worktree to share the project repository's common directory and, when the task has one, the common directory of its latest complete `channel.identity` binding (`Store.boundCommon`). A refusal is "none". Every later Git call of the operation revalidates that identity. Verifying an unknown commit, and an unknown push whose commit was not recorded, apply the same check and stay unknown on a mismatch, so commit verification also needs the project folder to be admissible.
  - **Reconciliation.** A push whose push and fetch URLs differ stays unknown, and SHA-256 remote tips are accepted.
  - **Push configuration.** The same allowlist over the repository's own scopes (`git config --list --show-scope -z`), the same refusal, and the same protocol flags (`protocol.allow=never`; `ext`, `git`, `http` denied by name; `https`, `ssh`, `file` allowed) on push and `ls-remote`.
  - **Remotes.** As native `RequireSupportedRemotes`: network-share URLs (UNC, device, `file://host`, any `file://` URL holding `%`, mapped or unavailable drive letters) are refused, and a local-path remote must sit on a fixed local drive with no link in its existing chain. A push refuses with "none"; a remote check stays unknown.
  - **Fixed in both runtimes by this change, from the independent review of the port.**
    - **Transports the protocol restriction denies (medium).** `http://`, `git://`, `ext::`, other `<helper>::` forms, other schemes, and any other spelling of the allowed ones (`HTTPS://`, `FILE:///`) passed the remote check, so Git refused them only inside `git push`. That recorded an unknown outcome which the remote check, refused the same way, could never resolve, so the task stayed blocked. Before a push or remote check, `IsPermittedRemoteForm` now admits only what Git uses under the restriction: lowercase `https://`, `ssh://`, `git+ssh://`, `ssh+git://` and `file://`, scp-like ssh, and local paths. It also refuses what Git itself refuses before connecting: leading whitespace (Git does not trim), a leading `-`, `rsync:`, and an ssh URL whose host starts with `-`. Anything else is refused with the same "none" message. A push that failed against such a remote before this change stays unknown.
    - **Spellings Git resolves elsewhere than the check (low).** Git opens `file://localhost/...` as the UNC path `//localhost/...`, so any `file://` host is now a share. It expands a leading `~` to HOME, so such a path is now refused. A drive-relative path (`C:repo`) is refused in both runtimes; TypeScript already refused it.
    - **Intent-to-add renames (low).** Status reports a worktree rename of an intent-to-add path in its second column, which the parser did not read as a rename, so a secret-named source was caught only by the staged screen after `git add`, with an unknown outcome. Both columns are now read, so it is refused before staging with "none".
  - **Differences, all fail-closed or invisible on success.**
    - Node has no `GetDriveType`, so the drive type comes from `System.IO.DriveInfo` in the fixed System32 Windows PowerShell, with no profile and only `SystemRoot`, `WINDIR` and the drive letter in its environment, as `backup-protection.ts` launches it. A failed query refuses the push and leaves a remote check unknown. A push or remote check to a local-path remote costs one or two such launches; https and ssh remotes cost none. Under PowerShell's constrained language mode the query would fail, so every local-path remote would be refused.
    - The chain is checked with `lstat`, which recognizes symbolic links and junctions. Native's pin refuses every reparse point. TypeScript also admits volume mount points, which lead only to another local volume, and other reparse points such as cloud-file placeholders.
  - **Tests.**
    - `tests/integration/publication-guards.test.ts` (13 cases) mirrors `TaskPublicationTests`:
      - each configuration key native refuses, plus a worktree-scope key;
      - the protocol restriction under a global configuration that allows every protocol and sends the remote through the ext helper (`remote.origin.vcs`), with a control proving the helper's command live;
      - remotes Git would refuse only once running, then the real remote, and the permitted-form table native shares;
      - share, percent, `localhost` and drive-type spellings, loopback shares and an unused drive letter;
      - a junction-linked remote, then its real path;
      - a staged `git mv .env safe.txt`, an intent-to-add worktree rename, and a secret renamed between the status screen and `git add`;
      - a tampered binding, a binding-less task, a replaced worktree with its own remote and a crafted commit, and a worktree replaced during a push;
      - a differing push URL and a SHA-256 remote.
    - Native: `PushRefusesRemotesGitWouldRefuseOnlyOnceRunning` and `PermittedRemoteFormsAreThoseGitUses` are new. `PushTransportsAreLimitedToHttpsSshAndLocalPaths` now uses the global `remote.origin.vcs` route, with its control. `AStagedRenameOfASecretNamedPathIsRefused` adds the intent-to-add rename, and `NetworkShareRemotesAreRecognized` classifies `file://localhost`.
    - In TypeScript, each of 22 mutations, one per guard, failed its test. Natively, each of the 7 new guards (permitted form, Git's early refusals, an option-like ssh host, `localhost`, `~`, drive-relative path, second status column) failed its test when removed.
  - **P2 vectors.** Re-pinned with their `P2_WRITE_*` flags. Only the `repository.ts`, `workspace-operations.ts` and `store.ts` source hashes changed, and `Foundry.Conformance` replays every corpus.
  - **Validation.** `pnpm check`, `pnpm test:e2e` and `Foundry.Conformance` (Release) on the final head; results are in the pull request. One e2e test, `personal-workspace.spec.ts` "pinned script remains untrusted until explicit reviewed grant", fails intermittently. It also failed 1 of 6 runs on a clean `main` build, so it predates this change.
  - **Independent review.** The security seat (`cloud-security-vulnerability-expert`; Sonnet, high effort, from its agent definition) reviewed the port as required for credential, filesystem and process changes.
    - First round: GO, conditional. Its findings were the run-time-refused transports (medium), the destination's own layout (medium), `file://localhost` and `~` (low), the intent-to-add rename (low), the `lstat` wording, and missing pin and drive-failure tests. All but the destination layout are fixed above, in both runtimes; that one is open for Rudy, below.
    - Re-review: GO. Its one low finding, Git's early refusals (leading whitespace, a leading `-`, `rsync:`, an option-like ssh host), is fixed above.
  - **Not in this change:** H1, the TypeScript hooks-folder fix, is #35 (`claude/fix-empty-git-hooks`, unmerged). Whichever of the two lands second re-pins the vectors.
  - **The destination's own layout (medium, confirmed by the independent review): decided by Rudy, 17 October 2026, and fixed in both runtimes.**
    - The remote check covers only the named path, but Git's local transport also opens the destination's own layout:
      - `<path>/.git`, `<path>.git/.git` and `<path>.git`; a push to a missing `dest` wrote into `dest.git`;
      - a gitfile, which needs no privilege. A folder whose `.git` file reads `gitdir: //host/...` sent both a push and a remote check through the share, probed on loopback;
      - `objects/info/alternates`, which can name a share.
    - For example, a project whose own configuration sets `remote.origin.url=./vendor` (an allowed key) and that ships `vendor/.git` as such a gitfile reaches the share when the user pushes or reconciles.
    - This extends Rudy's accepted limit that a local-path destination runs its own `receive-pack` hooks. Those hooks can already run any program on push, while the remote check of an unknown push runs no hooks but follows the layout.
    - The code and these notes now claim only that the named path is neither a share nor reached through a link.
    - **Choices considered:**
      - accept it as part of the limit;
      - screen the destination as Git's `enter_repo` walks it, refusing a gitfile, a linked `.git`, `alternates` and `commondir`;
      - refuse local-path remotes;
      - refuse only relative ones.
    - **Decision: refuse relative local-path remotes.**
      - A local-path remote must now be fully qualified: `C:\...`, `C:/...` or `file:///C:/...`. `./vendor`, `vendor`, `../x`, `.\x`, `\x`, `/x` and `file:///x` are refused with "none" before any transport, with their own message: "Remote <name> is not a full local path, such as C:\repos\name.git, which push requires for a local remote." A remote check stays unknown.
      - This subsumes the earlier `~`, drive-relative and empty-path refusals, and relative paths no longer resolve against the folder the command runs in.
    - **Why this cut.**
      - Content that arrives with a project cannot know where it will be unpacked, so a relative path is how it would name a destination it ships. That covers the reviewer's example, and a shipped destination with its own `post-receive` hook, which Git runs on push.
      - Screening the destination was rejected. It would reimplement Git's repository lookup, race the push, and still leave the destination's hooks.
      - Refusing every local-path remote was rejected for its cost. In-app pushes to local bare repositories would stop working, and every publication test and vector would need a test-only bypass in both runtimes.
    - **What it leaves.**
      - A fully qualified destination is the user's own and stays trusted, layout and hooks included, under the accepted limit. Changing a destination already on the machine needs prior write access to it.
      - A relative remote set up by hand must be changed to an absolute path before the app pushes.
    - **Tests.**
      - `tests/integration/publication-guards.test.ts` "refuses a relative local remote, the way project content would name a destination it ships" ships a bare `vendor` with a live `post-receive` hook inside the project. A control first shows plain Git running that hook through `./vendor`. Then every relative spelling is refused for push and left unknown for the remote check, the hook never runs, and the absolute path still pushes. The supported-remotes unit cases check the new message for every path that is not fully qualified (relative, rooted, `~`, drive-relative, empty).
      - Native `PushRefusesARelativeLocalRemote` covers the same scenario.
      - Accepting relative paths again failed each test, in both runtimes.
- **Running a non-ASCII approved command exactly as approved** (T1, 17 October 2026).
  - **The defect.** `job-runner.ps1` read its JSON spec with `[Console]::In`, which Windows PowerShell 5.1 decodes in the console's OEM code page, but `command-runner.ts` writes it as UTF-8. Every non-ASCII character of the approved command, its environment values, its working directory and the result and cancel paths reached the helper altered.
    - **Measured:** an approved `'café 東京 😀'` ran as `'caf├⌐ µ¥▒Σ║¼ ≡ƒÿÇ'` and the run was reported with exit code 0.
    - **Launch failures:** a non-ASCII working directory failed `CreateProcess`, and a non-ASCII result folder failed the result write, so the command was recorded unknown. A non-ASCII cancel path was never seen, so a pre-launch cancellation did not stop the command.
  - **How it was found.** The P2.3a oracle found it, on the unmerged branch `claude/p2.3-commands-approvals`. The native runner there passes the exact text, so that branch's conformance vectors name this as a difference.
  - **The fix.** The helper reads standard input through a strict UTF-8 reader. It does not detect byte-order marks: a spec with invalid UTF-8 or a byte-order mark fails before launch, and the command is recorded unknown. Node never writes either, so this is defence in depth.
  - **Visible consequence.** Non-ASCII text that a command echoed from its own source used to look right, because the two mis-decodings cancelled out. It now shows the shared output limit: PowerShell encodes output in the console code page, and this runtime and the P2.3a native runner both decode it as UTF-8, so such output becomes U+FFFD or `?`.
  - **Tests.** `command-runner.test.ts` runs a command with non-ASCII text, a non-ASCII environment value and a non-ASCII working directory. It pins the bytes the command writes. A pre-launch cancellation in a non-ASCII result and cancel folder must be verified. A spec with a raw `0xFF` byte or a byte-order mark must exit before launch, with no result and no effect of the command. The first two, and the `0xFF` case, fail without the fix.
  - **Native side.** Main has no native command runner yet. The P2.3a runner is not affected, and this change leaves C# unchanged. Once both are on one base, regenerating P2.3a's `tests/p2/command-runner-vectors.json` should remove the named difference at "runs exactly the approved command" #12/#14.
  - **Open, same class, TypeScript only.** These are not changed here:
    - **MCP and hook spec files.** `mcp-host.ps1` reads its spec file with `Get-Content -Raw`, which decodes in the ANSI code page. `mcp.ts` and `hook-runner.ts` write that file as UTF-8 without a byte-order mark. So the MCP server command, a trusted script's pinned arguments, the working directory and the environment can arrive altered. Measured with the same `Get-Content` call (`'café 東京 😀'` read as `'cafÃ© æ±äº¬ ðŸ˜€'`); not run end to end.
    - **Add-Type and a non-ANSI `TEMP`.** Both helpers compile their types with `Add-Type`, which cannot write its assembly when `TEMP` holds characters outside the ANSI code page. Measured: `é` compiles under code page 1252, while `東京` and `😀` fail. On such a profile no approved command can launch, with or without this fix. The MCP and hook host compiles the same way. Measured in isolation, not on such a profile.
- **Redacting the approval `approval.reconcile` returns** (17 October 2026, review finding L1 of P2.3b).
  - **The exposure.** `approval.reconcile` returned the whole stored approval unredacted: command, file contents, environment values, the result and patches. The three approval read methods redact all of these. A renderer call (including a compromised renderer's) received any secret in that text in clear. The only renderer caller discards the value, so nothing was kept in state.
  - **The fix.**
    - Reconciliation now returns exactly what `approval.get` shows: the document redacted, and a bounded preview above 128 KiB (which also keeps a large approval within the response limit).
    - If redaction leaves the document unparseable, it returns the identity, state and outcome, every text field redacted on its own; the state is the runtime's own value. The state is already saved, so a refusal would misreport a check that happened. A field the document lacks stays absent.
    - The stored row is unchanged. The `Approval` return type is unchanged, so the protocol is unchanged; its comment now says a large approval comes back as a preview.
  - **Where.** `workspace-queries.ts` exports its existing projection (`readApproval`); `tool-runtime.ts` `reconcile` returns it.
  - **Tests.** `tests/integration/coding.test.ts` covers a labelled secret, a learned secret in an edit's file contents, a 140,000-character approval, and an unparseable redaction with a learned secret in its identity fields. Returning the raw approval fails it, and so does copying the fallback's identity fields unredacted.
  - **Independent review** (`cloud-security-vulnerability-expert`, Opus at high effort): **GO** for `677dc16..2ff43b3`. It verified both seals and ran `coding.test.ts`.
    - **L1-a (low), fixed in the next commit.** The fallback copied the identity fields and fingerprint unredacted, so a learned secret in a provider's `toolCallId` could leave the runtime. Every text field is now redacted, in both runtimes.
    - **I-1, closed by the same change.** A stored approval without a summary made the fallback throw after the save; it now reports the approval without one.
    - **I-2.** A caller cannot tell a preview from the whole approval. The protocol comment now says so.
    - **Re-review of `b66735e`: GO.** L1-a, I-1 and I-2 are closed. Not blocking: any failure of the read after the save takes the fallback, which is now fully redacted.
  - **Validation of `b66735e`** (run2, from a `git archive` export): native 7,164 passed, 0 failed, 2 expected skips; `pnpm check` 569 passed; `pnpm test:e2e` 21 passed; `pnpm package:dir` and `pnpm smoke:package` passed; `git diff --check` clean.
  - **Native half (P2.3 branch).** `ToolRuntime.Reconcile` returns `Store.ApprovalRead`'s projection, using the chat's `Redactor`, with the same fallback.
    - **One difference, fail-closed.** Native takes the fallback only when the redacted document does not parse (`WorkspaceReadException`). TypeScript's catch-all also covers a store read that fails just after the save; native reports that as a runtime failure.
    - **Oracle.** The approval oracle gains six reconciliations: labelled secrets in a command and its environment, a command above the preview bound, unterminated private keys on a command and on a completed edit without a `toolCallId`, labelled secrets in the fallback's `toolCallId`, nonce and fingerprint (L1-a), and a fallback without a summary (I-1). Its vectors are regenerated from this source.
    - **Mutations.** Seven of eight native mutations fail the replay, among them copying the fallback's fields unredacted and writing absent fields as null. Leaving the fallback's result content unredacted survives, because reconciliation writes only runtime-authored result text.
    - **Corrupt-data edges (informational, named by the review).** For a stored approval above 128 KiB, a missing summary previews natively as an empty one, where TypeScript's projection throws and its fallback omits the summary; a `path` that is not a string faults native, where TypeScript falls back. Neither leaks, and the runtime always writes both as strings.
    - **Review** (the same reviewer): **GO** for `07de8b3..985d6f3`. It verified the seal and that the cherry-picked TypeScript files match `b66735e` byte for byte, ran the replay (9 passed), and confirmed the shared `Redactor`, the fallback's key order and absent fields, and that the named difference is fail-closed.
    - **Validation of `985d6f3`** (from a `git archive` export): native 7,212 passed, 0 failed, 2 expected skips; `pnpm check` 571 passed; the stdio differential passed; `git diff --check` clean. An earlier run of `0c1b727` failed once in `JobProcessTests.StartupDiagnosticsAreBoundedAndDoNotConsumeOutput`. That test dates from #32, races the console host's exit, and passed 10 of 10 alone. Evidence is in `foundry-evidence\fix-l1-reconcile-redaction`.
- **Keeping worktree reads off the index lock during an approved integration** (18 October 2026).
  - **The defect.** `git-operations.ts` ran `git status` with Git's optional locks on. Every read of a worktree therefore held its `index.lock` while Git refreshed the index.
    - `orchestration.get` reads the root worktree (`completionState` → `state`). The renderer calls it right after each Approve and on every event.
    - An approved `git cherry-pick` that started while such a read held the lock exited with "Unable to create index.lock".
    - It was recorded as a failed integration with no effect, and the coordinator stopped.
  - **How it showed up.** The coordinated-workflow e2e failed intermittently on main's CI (runs 39068678776 and 39076689934): no approval card, and a coordinator that never finished.
    - CI kept no state, so this cause is inferred, not observed.
    - The lock race was measured in isolation: 2 of 40 cherry-picks failed against concurrent `git status`, none with optional locks off.
    - The stopped state was reproduced by holding the lock during the approved cherry-pick.
  - **The fix.**
    - Every Git call in `git-operations.ts` runs with `GIT_OPTIONAL_LOCKS=0`.
    - A refused cherry-pick or continuation now carries Git's own first error line in its detail.
  - **Not changed.** `gitEnvironment()`, `repository.ts` and the `command-runner.ts` fingerprint still take the optional lock, so the P2 vectors are unchanged.
    - None of them reads the root automatically during an integration: they are commit verification, retirement, the continuation-source check, and the pre-approval fingerprint.
    - `git diff` against the worktree refreshes the index regardless of the variable.
      - `task.diff` runs it when a task is selected, when the coordinated view opens, and on the inspector's Refresh. Opening a coordinated task during its integration can therefore still refuse the cherry-pick, which then reports Git's reason.
      - It also runs inside a child's own handoff, in sequence with that child's commit.
  - **Native side.** There is no native orchestration Git yet. The port of `git-operations.ts` must run its Git with optional locks off.
  - **Tests.**
    - `git-operations.test.ts`: `state()` and `changedPaths()` leave a stat-dirty index byte-for-byte untouched, with a control proving plain `git status` rewrites it. This failed before the fix.
    - `git-operations.test.ts`: a held `index.lock` makes `cherryPick` return no effect with Git's reason.
    - The e2e now fails as soon as the coordinator stops, and writes the orchestration state, transcript, UI text and screenshot to its output folder.
    - The Portable Windows workflow uploads `test-results/` when the e2e step fails.
- **A linear Responses completion check** (18 October 2026, review finding N2 of P2.4b).
  - **The defect.** `validateResponseCompletion` compared every streamed output item with every completed one, and serialized both contents for each comparison.
    - A hostile or compromised endpoint can stay within every cap: 10,000 events, a 1 MiB completion and 8 MiB per stream.
    - The P2.4b security review extrapolated about 3 minutes for TypeScript at those caps, and about 25 minutes for the native port, which had the same algorithm.
    - The check runs synchronously. The runtime answered nothing meanwhile, and the turn limit could not stop it.
  - **The fix.** Each item has one key, which is equal exactly when the old comparison matched:
    - the type, and either the string id or the absence of one;
    - for a function call, its call id, name and arguments;
    - otherwise, the serialized content, or the absence of content.
    - Those comparisons use `===`. An item whose compared value is an object or an array can therefore match nothing from another parse, and its key is none.
    - The completed items are indexed once, so the work is linear. Results and messages are unchanged.
  - **Evidence.**
    - The five oracles bound to `index.ts` were regenerated: fake tools, Git chat, profiles, provider transport and provider streams. Each vector file changed only in that source's SHA-256.
    - `providers.test.ts` counts the serializations for 200 streamed items. There were 40,202 before the fix, against a bound of 850.
    - The native half is `49cbbad`, where `ProviderStreamNativeTests` bounds the parsers' allocations.
  - **Not dual-landed: N1.** Its quadratic string building was native-only, because V8 builds appended strings as ropes.
  - **Kept by Rudy, 18 October 2026.** He accepted the security classification, so `bbfa5d5` stays.
- **Answering every pending Anthropic call on resumption** (18 October 2026, finding T-1 of P2.4a).
  - **Why it lands under the freeze.** It is neither a security nor a data-loss defect. Rudy approved fixing it in both runtimes on 18 October 2026.
  - **The defect.** A stored Anthropic continuation could have more than one pending call while the next request carried exactly one user message. `nativeRequest` then merged that message with the first result's `tool_result` block only.
    - That is the path `prepareRequest` takes after an interrupted turn, such as a cancellation while two tool calls ran.
    - The other `tool_use` blocks reached Anthropic unanswered, which its API refuses. Every later turn of that task failed the same way. The retained state stayed intact.
  - **The fix.** The merged user message carries every result's block, then the text.
    - The results keep the request's order. `requiredResults` returns them in that order, and the unmerged path already sends them so.
    - `requiredResults` still refuses a missing, duplicated, misnamed or foreign result before the merge.
    - With no new message, or more than one, each result is still its own user message.
  - **Native side.** `AzureRequests.Prepare` had ported the defect on purpose (P2.4a). It now builds the same body.
  - **Evidence.**
    - **Oracles.** The six bound to `index.ts` were regenerated under Electron 44.4.1's Node 24.21.0, on a throwaway branch that merged #48's write guard. Only the vector files were kept.
      - `provider-transport` cases 144 and 146 now carry both results. These are Anthropic resumptions with two pending calls, results in the reverse of the calls' order, and one user message, the second case after a system message.
      - `provider-streams` case 86 (two calls) carries both. Case 145, appended so no case is renumbered, has three calls with the second rejected.
      - The other four oracles (external chat, fake tools, Git chat, profiles) changed only in that source's SHA-256.
    - **Tests.** `providers.test.ts` and `AnthropicResumptionTests` send two and three pending calls, with the results in the reverse of the calls' order and one user message after a system message. Each fails without the fix.
    - **Mutations** (`foundry-evidence\t1-anthropic-results\mutations-run1`): six per runtime, all caught. They sent the first result only, reversed the order, put the text first, skipped the merge, sent the last result only, and sent the first two only.
      - Every vector pins the source's SHA-256, so the TypeScript mutations were judged by regenerating the two provider oracles and comparing them case by case.
      - The new tests and the four cases above catch each mutation. "First two only" is caught by the three-call tests and case 145 alone.
    - **Review of `1972de7..e621627`.** Security (`cloud-security-vulnerability-expert`, Opus at high effort): **GO**.
      - **What it verified:** both runtimes build the same blocks in the same order, under an unchanged condition, and store the history they send. Result validation still runs before the merge. No new kind of data leaves: these results were already sent unchanged on the other paths.
      - **Budget:** the context estimate already counted every result, so it no longer over-counts.
      - **Oracles:** it compared all six files case by case. Exactly the four cases above changed, none was renumbered, and nothing from #48 came across.
      - **Low:** this document still called T-1 unfixed. Corrected here.
      - **Informational, pre-existing:** the stored assistant turn of transport cases 144 and 146 has no `tool_use` for `call-2`, so Anthropic would refuse their bodies before and after the fix. Real state cannot produce this, because the calls come from that turn's content, and neither runtime checks it. No Anthropic refusal case uses one user message, so only the order of the code protects the merged path. A single empty user message would still become an empty text block.
    - **Validation of `590e0b4`** (from a `git archive` export, `foundry-evidence\t1-anthropic-results\run1`, seal `seal-590e0b4.txt`):
      - Release build with warnings as errors: clean.
      - Native suite: 7,948 tests, 7,946 passed, 0 failed, 2 expected skips.
      - `pnpm check`: 594 of 594 passed across 96 files.
      - The stdio differential: 3 of 3. `git diff --check`: clean.
      - Under Electron's Node 24.21.0, the fake-tool, stream and transport oracles and `providers.test.ts` pass in check mode, 19 of 19.
      - No renderer, IPC or user-path source changed, so no Electron E2E run was required.
    - **Validation of `6457ca1`**, the T-1 branch merged with P2.4's `255868e` (main with #48), from a `git archive` export (`foundry-evidence\t1-anthropic-results\run2`, seal `seal-6457ca1.txt`):
      - No source an oracle pins changed between `1972de7` and `255868e`, so the regenerated vectors still hold.
      - Release build with warnings as errors: clean. Native suite: 7,948 tests, 7,946 passed, 0 failed, 2 expected skips.
      - `pnpm check`: the first run passed 593 of 594. `publish.test.ts`'s push test hit its 30-second Git timeout while another of the owner's processes loaded the machine. That file then passed alone (18 of 18), and a second full run passed 594 of 594 (`rerun-publish.log`, `rerun-pnpm-check.log`).
      - Under Electron's Node 24.21.0, as the portable job runs them: every P2 oracle passed, 38 files and 65 tests, and the git-metadata oracle passed 698 vectors.
      - The stdio differential: 3 of 3. `git diff --check`: clean.
- **Reporting a background descendant only while one is still running** (18 October 2026).
  - **The defect.** After a command's root exited normally, `job-runner.ps1` reported "[background job descendants terminated]" whenever the job's process count was not yet zero. Windows can still count and list the root for a moment after its exit is signalled. A plain command could therefore report a descendant it never had.
  - **How it showed up.** The P2 command-runner oracle failed once on #50's portable run 39172855866 (attempt 1), under Electron's Node, on a runner about twice as slow as usual.
    - The step was "consumes each prepared command once" #1, a plain `[Console]::Out.WriteLine('once')`. It reported the marker, and its vector records none.
    - The same oracle had passed under Node minutes earlier on that runner.
  - **Reproduced.** An instrumented copy of the helper ran the same command under CPU load: 16 runs at a time, beside 48 busy processes, on 24 logical processors.
    - 6 of 1,470 runs reported the marker, 3 under Electron's Node and 3 under Node. Unloaded, 0 of 40 did.
    - In every one, only the root had ever joined the job (`TotalProcesses` 1). The job listed the root with its exit code already set, or listed nothing, and was empty within 3.5 ms.
    - No console host or descendant was involved.
  - **The fix.**
    - After a normal exit, anything left in the job is still terminated.
    - The marker is reported only when a listed process is still running. An id that no longer opens has gone, and a process whose exit code is set has exited. A live process that cannot be read counts as running.
    - The command has run by then, so the decision never throws. If the job counts more members than it lists, it waits for the two to agree. A list that cannot be read, or does not settle within a second, counts as a descendant, as before.
    - Natively, `JobProcess.ProcessImages` applies the same exited-or-running rule. The native runner also ignores the system console host, which this job never holds, because the command shares its helper's console.
  - **After the fix.** Load runs cannot show it: the window did not open again.
    - 2,300 runs of the fixed helper reported no marker. Interleaved with 700 of them, the unfixed helper saw no race either, even with more load and process churn.
    - The fix rests on the recorded states instead. Each of the 6 was the root with its exit code set, or an empty list. `Running` classifies the root as not running. An empty list has nothing to report once its count agrees.
  - **Native side.** Not affected: the native runner asks `ProcessImages`, which leaves out an exited process. No native behaviour changes. That rule had no deterministic test until this change.
  - **Tests.**
    - `packages/runtime/tests/command-runner.test.ts` compiles the helper's own types.
      - It pins `Running` on the window's exact state: a process that has exited while its handle is held is not running, the test's own process is, and process 0 never opens. Ignoring the exit code fails it.
      - A job of 20 processes, more than the first 16-entry buffer, reports a running member, then none once all have exited. Reading the ids at the wrong offset fails it, and so does treating a full buffer as an empty job.
    - Native `AnExitedRootIsNotLiveWhileItsHandleIsHeld` pins `JobProcess.ImagePath`, now internal, on the same state. Ignoring the exit code fails it.
    - The window itself cannot be held open, so no deterministic test covers the decision on a lagging count. The load runs above are its evidence.
    - A real background grandchild still reports the marker: the oracle's "ends the whole tree on timeout, cancellation and a normal exit" #7 and `security-audit.test.ts`.
  - **Vectors.** `command-runner-vectors.json` and `tool-runtime-vectors.json` were regenerated under Electron's Node. Only the `job-runner.ps1` hash changed; no recorded outcome did.
  - **Independent review** (`cloud-security-vulnerability-expert`, Sonnet at high effort, from its definition): **GO with conditions** for `44c767d..27fa99f`. No path lets a running descendant survive, and none newly reports success or verified cleanup.
    - **F1 (medium), fixed.** The first version grew its buffer on any count mismatch, then threw "did not settle". A throw after the command ran records it as unknown and loses its output, which is worse than the phantom marker. The decision now waits for the list to settle and never throws.
    - **F2 (low), accepted.** A root that exits with code 259 (`STILL_ACTIVE`) during the window still reports the marker. That is the conservative direction, and native does the same.
    - **F3 (low), fixed.** The combination of the list and `Running` was untested; the 20-process test covers the list parsing and buffer growth.
    - **F4 (low), fixed.** This entry overstated equivalence with native and how the empty-list state is classified.
    - **Open, native only, not changed here.** `ProcessImages` throws on a list that does not settle, before the job is terminated. Kill-on-close still reclaims the tree, and the run fails rather than reporting success. It predates this change.
    - **Re-review of `721ea12`: GO.** F1 is closed. Not blocking: if a lagging count never settles, a genuine descendant can run up to a second longer before the job is terminated.
  - **Codex review of #51 (P2), fixed.** A listed member could start a child and exit between the list and its check. The scan then saw only the exited parent, so the marker was left out, though the new child was still running when the job was terminated.
    - A list with none running is now read again. The decision settles only when no new member appears.
    - Members are named by id and creation time, so a reused id counts as new. Churn that does not settle within the second counts as a descendant.
    - The window cannot be held open, so no deterministic test covers the second read.
    - **Independent re-review of `cbcd234`: GO.** The reviewer checked the argument that nothing can start once a second read adds no new member. Not changed, all low: an id that never opened is named by 0 alone, which matters only in an unrealistic reuse case; the churn loop spins without sleeping until the one-second bound.
  - **Validation of `cbcd234`** (main merged, with #47).
    - `pnpm check`: 596 passed.
    - `pnpm oracle` under Electron's Node: 65 passed across 38 files.
    - Native: 7,949 tests, 7,947 passed, 0 failed, 2 expected skips.
    - `pnpm test:e2e`: 21 passed.
    - `pnpm package:dir` and `pnpm smoke:package`: passed.
    - `git diff --check`: clean.
  - **Validation of `721ea12`.**
    - `pnpm check`: 589 passed.
    - `pnpm oracle` under Electron's Node: 61 passed across 34 files.
    - Native: 7,333 tests, 7,331 passed, 0 failed, 2 expected skips.
    - `pnpm test:e2e`: 21 passed.
    - `pnpm package:dir` and `pnpm smoke:package`: passed.
    - `git diff --check`: clean.

| Seat | Model / effort | Selection source | Routing reason |
| --- | --- | --- | --- |
| Architecture and delivery (`architecture-review-agent`) | Sonnet / high | Agent definition frontmatter | Independent architecture view; parallel reading of main, protocol, runtime and providers |
| Security (`cloud-security-vulnerability-expert`) | Sonnet / high | Agent definition frontmatter | Required independent review for credential, IPC, filesystem and process changes |
| Data integrity and concurrency (`db-steward`) | Sonnet / high | Agent definition frontmatter | In-place adoption and the Node-to-.NET concurrency model carry the highest-consequence risk |

The owner (Claude Opus 5.5, max effort) chaired two review rounds and kept the test strategy and synthesis. The owner also verified the disputed facts, for example the CDP `grantUniveralAccess` spelling and that `setCredential` clears profile verification. The review produced a plan, not an implementation; its acceptance criteria are not evidence that any migration phase exists.

## P1 contract and platform foundation — local implementation delivered

Recorded 12 October 2026. Rudy authorized proceeding locally on the accepted P0 records before their integration: “Yes—continue P1 locally; keep integration held.” He subsequently authorized private publication and Windows CI. Main integration and real-data adoption remain held; the later P2 authorization is recorded below. The development executable requires an explicit isolated data directory; existing data additionally requires the disposable-copy marker. A marker never grants real-root admission.

The baseline inventory is `tests/Foundry.Conformance/BaselineInventory.json`: starting revision `e5517ac410f7ab6d5099a380b4114a25e5247f69`, local prerequisite revision [3bf7462](https://github.com/koala-man-64/foundry-agent-workspace/commit/3bf7462e085368a4eb34cc1fdc5e9b3cef84513c), unchanged SDK/package pins, hashes of all ten golden files and fifteen era-fixture files, and the complete contract inventory. Inspection found **89 existing RPC methods**, not the historical plan's 86; five non-RPC frames, two RPC envelopes and three bridge inputs make 99 schemas. No protocol methods were added.

Baseline validation: locked .NET restore and Release warnings-as-errors build passed; existing solution tests passed 171 with one environment-policy skip. Baseline `pnpm check` passed type checking, lint and 483 TypeScript tests. Final P1 validation: locked restore; full Release build with warnings as errors, zero warnings/errors; all Microsoft.Testing.Platform solution tests: **4,439 passed, zero failed, one intentional ephemeral-CI registry-policy skip, 4,440 total**. This includes **4,268 conformance tests with no skips**, frozen corpus normalization, supporting parity vectors, every era opening/recovery and schema structure, loop affinity/shutdown, transaction/outbox faults, protected WAL-aware backups/upgrades, filesystem admission and process framing/EOF/limits/resource release. `pnpm check` passed type checking, lint and **490 tests across 55 files**, including immutable golden/oracle cases. `git diff --check` passed. The committed revision is retained in `test-results/p1-final-revision.txt`; final logs are `test-results/p1-final-{restore,build,tests,pnpm-check}.txt`. Required checks run again after the final evidence amendment, so these logs identify the exact final revision rather than an earlier working tree.

Independent read-only security and data/concurrency reviews accepted the current P1 source. Both used GPT-6 Luna/max, selected by the supplied AGENTS.md Critical lane approved tuple from the provider-confirmed GPT-6.1 Sol/medium owner. Security independently rebuilt and passed 4,240 focused conformance tests; data review independently rebuilt and passed all 10 backup/upgrade regressions. Reviewed byte fingerprints and scope are retained in `tests/Foundry.Conformance/ReviewedSources.json`; Git text normalization can change line endings. The owner fixed and regression-tested filesystem link/rename admission, strict ISO/time-zone parity, rejected asynchronous transaction callbacks, loop shutdown/late continuations, failed rollback publication, exact typed backup verification and broken stdout. No shipping TypeScript defect with a present-path trigger was established. A proposed TEXT/blob backup finding was withdrawn after verification against pinned Microsoft.Data.Sqlite 10.0.12 and its regression test. Review agents could not register provider sessions with agentcoord (`session_token_unavailable`) and made no edits or resource claims.

The **P1 implementation is privately delivered and Windows-qualified** in six reviewable increments plus the disposable-fixture CI correction. [Final source 3d0fab7](https://github.com/koala-man-64/foundry-agent-workspace/commit/3d0fab7442f7f1bbb78470423e1d53893125ca6b) passed [Windows CI 38343524316](https://github.com/koala-man-64/foundry-agent-workspace/actions/runs/38343524316): locked restore, zero-warning Release build, **4,440 tests passed, zero failed or skipped**, including the registry-policy gate. Main integration is a separate held authorization and is not implied by publication or CI success. FULL SQLite durability and publication only after the outermost commit are the two approved behavioral differences. The strict incoming parser keeps the named S8b differences, while persisted parsing preserves unknown properties and opaque provider state. Adoption operations, v6 fences, renderer changes and shipping packaging remain deferred.

| Local increment | Revision and validation |
| --- | --- |
| 1 — baseline and conformance harness | [ecfeb3f](https://github.com/koala-man-64/foundry-agent-workspace/commit/ecfeb3f065759c9d822a1ea442fcade5960b1479). Validated from a clean `git archive` snapshot: locked restore; Release build with warnings as errors, zero warnings/errors; Microsoft.Testing.Platform solution run: 171 passed, 2 environment skips, 173 total. The skips are the ephemeral-CI-only registry-policy test and the CDP test because the archive has no `node_modules`. The owner checkout's existing baseline run passed CDP and had only the policy skip. Logs: `test-results/p1-increment1-{restore,build,tests}.txt`. Inventory coverage and committed input hashes pass. |
| 2 — protocol and parity utilities | [020b929](https://github.com/koala-man-64/foundry-agent-workspace/commit/020b929a31747ebdf459d263e85e1dfe33473941). Clean archive snapshot locked restore, full Release build with warnings as errors (zero warnings/errors), 4,198 conformance tests passed with no skips. Logs: `test-results/p1-increment2-{restore,build,tests}.txt`. Covers all 99 frozen schemas, 89 typed result surfaces, strict string/byte parsing, framing, JavaScript serialization/hashes, redaction/MCP checks, manifests and committed schedule vectors. Node regressions verify offsets through ±23:59, year zero, expanded-year normalization and fraction truncation. |
| 3 — execution loop | [1392079](https://github.com/koala-man-64/foundry-agent-workspace/commit/13920792061441ede78a0fb995a5d21c2bb0b882). Clean archive snapshot locked restore, full Release warnings-as-errors build with zero warnings/errors; 4,209 conformance tests passed without skips. Logs: `test-results/p1-increment3-{restore,build,tests}.txt`. FIFO posting, atomic admission/closure, await interleaving, thread/context affinity, task/cancellation and raw-context failures, state-free offload, async-void rejection, late-continuation denial, drain and thread joining are covered. |
| 4 — Store opening, schema and recovery | [d1767de](https://github.com/koala-man-64/foundry-agent-workspace/commit/d1767dee4b4bbb8989769cf84287cc42d28f1c8a). Clean archive snapshot locked restore and full Release warnings-as-errors build passed with zero warnings/errors; 4,235 conformance tests passed with no skips. Logs: `test-results/p1-increment4-{restore,build,tests}.txt`. All six eras (including WAL) retain version and match committed normalized schema/row changes; backups compare every schema object and exact typed cell bytes/rowids. Schema SQL and execution order match the TypeScript manifest byte-for-byte. Fresh/v≤5 data, real-root/alias denial, v6/fence refusal, marker and database link denial, rollback and protected backup faults are covered. |
| 5 — transaction and event outbox acceptance | [bea2cd1](https://github.com/koala-man-64/foundry-agent-workspace/commit/bea2cd1d6dc5e85f08f93012ce3ffe5d3b1f0916). Clean archive snapshot locked restore and full Release warnings-as-errors build passed with zero warnings/errors; 4,242 conformance tests passed with no skips. Logs: `test-results/p1-increment5-{restore,build,tests}.txt`. Covers deferred/immediate nesting, savepoint rollback, command enlistment, task-returning callback rejection, complete rollback, durable sequence ordering, no early publication, sequence-zero progress and committed mutation authority after delivery failure. |
| 6 — development runtime and summary | Final private branch HEAD (link unavailable), recorded in `test-results/p1-final-revision.txt`. Exact-final full-solution and TypeScript evidence is listed above. Implements only `workspace.summary`, preserving bounded pages, cursors, preferences, event sequence and runtime shape. Known unsupported methods validate before a bounded rejection; no partial handler executes. Process tests cover fragmented/multiple/malformed/oversized frames, Unicode, fixture and populated summaries, request IDs, output limits, broken stdout, startup refusal, EOF draining and resource release. Committed Node summary vectors are ordinary immutable expectations. |

The synchronous transaction/outbox primitives are co-located with Store opening in increment 4 because recovery must run atomically and persist its transition events. Increment 5 separately earns the transaction/outbox fault and publication gate; it introduces no feature mutations. No upgrade or adoption operation is exposed by the executable.

Development invocation requires an explicit new disposable directory, for example:

```powershell
$env:FOUNDRY_WORKSPACE_DATA = 'C:\tmp\foundry-p1-scratch'
dotnet .\src\Foundry.Runtime\bin\Release\net10.0-windows\Foundry.Runtime.dll
```

Send newline-delimited JSON-RPC on stdin. Stdout contains only protocol frames. Existing fixture/scratch copies require `.foundry-p1-isolated` with the exact declaration `P1 disposable development data; not adopted application data.` followed by a newline; this declaration does not override real-root or alias refusal. Tests use injected roots, immutable fixture copies and controlled clocks/IDs. Do not point this executable at application data. The shipping Electron supervisor continues to run TypeScript.

The final-check first pass exposed an architecture regex matching the forbidden construct's name inside a private exception message. Changing only the diagnostic text to `async-void` passed both reviewers' exact-delta review. A pre-existing TypeScript trace-normalization test also failed because stdout and stderr delivery interleaved differently; its isolated rerun passed all eight tests, without weakening expectations or changing shipping code. Initial failed evidence is retained in `test-results/p1-final-tests-initial-failure.txt` and `test-results/p1-final-pnpm-initial-failure.txt`; isolated trace evidence is `test-results/p1-trace-retest.txt`.

Cleanup evidence comes from process, Store, backup and loop tests: child exit, released SQLite files, removable disposable data directories and joined loop threads. One independent review scratch directory remains ignored at `tests/Foundry.Conformance/bin/Debug/net10.0-windows/marker-review-m9385xnshadmv5dnlq2`. Execution policy rejected its recursive deletion; no alternate deletion route was attempted. This retention is separate from tested runtime resource release.

Remaining gates and risks: the existing WebView2 registry-policy test intentionally runs only on an ephemeral Windows CI runner; the first hosted run exercised it successfully, but the full corrected-revision Windows run must also pass. Main integration and real-data adoption remain held. Native Windows ICU behavior is pinned by committed Node vectors, and URL compatibility is bounded by the committed corpus; future P2 inputs may require additional differentials. P2 must start with security suites and Store/projects/tasks under a fake provider. All other runtime handlers, Electron switching, v6/adoption and cutover remain deferred and require their own authorization. No renderer or shipping packaging path changed, so Electron E2E and packaging gates remain at P2 under the approved P1 scope.

After P0, the approved phase ranges total **33–44 weeks** through P5; after P1 they total **29–39 weeks**, retaining the original solo-plus-AI uncertainty (±40%). Increment 1 found three already-existing methods beyond the historical inventory; it added no feature scope. Keep P1's approved 4–5 week range as a planning baseline, rather than deriving a delivery date from local test speed. Refine the P2 range after its first security/store/tasks slice. No schedule estimate authorizes integration, adoption or cutover.

### Hosted Windows qualification continuation — 12 October 2026

Rudy authorized publishing the private P1 branch and running Windows CI, while explicitly keeping main integration, adoption and P2 held. The [accepted foundation source](https://github.com/koala-man-64/foundry-agent-workspace/commit/d142e705e8d985f5af917853ec07187778222cd2) and its six increments are now published. [Hosted run 38342056907](https://github.com/koala-man-64/foundry-agent-workspace/actions/runs/38342056907) passed restore/build and all platform/WebView2 tests, including the registry-policy test, with no skips. The full run failed four summary-era comparisons: the synthetic fixture paths existed on the generator's machine but not on the hosted runner. Its complete log is retained at `test-results/p1-windows-ci-38342056907.log`; this failure is not reported as P1 success.

The qualification correction changes only the C# summary test and its TypeScript oracle. Each materializes project folders beneath its private disposable copy, updates only copied `data.path`, and normalizes only returned paths to the unchanged committed wire expectations. Original fixture bytes and `path_key` values are preserved; production code and shipping paths are unchanged. Both now exercise disappearance of an owned project folder and assert the raw `unavailable` result. Generated numeric directory names and canonical containment checks bound setup/deletion, and TypeScript assertions remain outside the dispatch-error catch. Independent security and data reviewers (GPT-6 Luna/max, supplied AGENTS.md Critical lane selection) accepted this exact bounded delta after those containment improvements.

During the security review, a Python SQLite read-only probe against original fixtures created/touched sidecars. The reviewer disclosed the operations and stopped. The owner preserved those bytes under `test-results/fixture-review-sideeffects`, restored the tracked SHM bytes from the accepted revision, and moved only the generated untracked sidecars into that evidence directory. Full inventory/hash validation is required again; no original database or WAL was rewritten. Reviewers must inspect source or disposable database copies, since read-only SQLite can still alter WAL/SHM sidecars.

The corrected exact-revision Windows run passed and the P1 owner closed its work, claims and session. Evidence is retained in `test-results/p1-windows-ci-final.json` and `test-results/p1-publication-ownership-closeout.json`. Main integration, real-data adoption, v6 and shipping changes remain held independently. P2 was subsequently authorized below. The sticky hook-classification fix is owned by the separate project-bound chat `1. Fix sticky delivery intent (AB4032)`; its source/CI/install/trust gates do not change the P1 result.

## P2 runtime port — in progress

Recorded 13 October 2026. Rudy instructed “proceed with p2.” This authorizes the approved ordered runtime port and its development-only Electron integration once the relevant slices pass; it does not authorize main integration, real-data adoption, schema v6 or cutover. Work starts from [P1 revision 3d0fab7](https://github.com/koala-man-64/foundry-agent-workspace/commit/3d0fab7442f7f1bbb78470423e1d53893125ca6b). The app attached a separate P2 worktree, but the central hook's active-checkout containment rule denied Git mutation there. Prepared changes were preserved and copied into the clean active checkout on the private `codex/p2-runtime-port` branch (link unavailable), at the identical base. No outside-checkout Git mutation or hook bypass occurred. The Electron/TypeScript application remains the shipping product and behavioral authority.

The first increment ports stateless scope normalization, segment-aware coverage/overlap, dependency-graph cycle/reachability checks and network/device path classification. JavaScript ASCII-only regular-expression case folding, ECMAScript lowercase, UTF-16 ordering/error truncation and exact error messages are preserved. The existing summary path classifier now uses the shared prefix policy without changing admission behavior. These helpers confer no filesystem or command authority. `tests/p2/security-vectors.json` holds **855** committed Node outcomes; ordinary Node and C# tests never regenerate expectations. Coverage includes the existing scope/network cases plus Unicode, invalid/secret/reserved paths, path-count limits, graph errors and path-prefix negatives.

Increment validation: locked restore and full Release build with warnings as errors passed with zero warnings/errors. Microsoft.Testing.Platform: **5,294 passed, zero failed, one local registry-policy skip, 5,295 total**, including **5,123 conformance tests without skips**. The ordinary Node oracle passed. `pnpm check` passed type checking, lint and **491 tests across 56 files**. Logs are retained in `test-results/p2-security-{build,all-tests,node-tests,pnpm-check}.txt`; the active checkout's repeated build/solution checks use `p2-security-active-{build,tests}.txt`. Independent read-only security review by the existing GPT-6 Luna/max leaf, selected through the supplied AGENTS.md Critical lane approved tuple, accepted the production policy delta and independently passed the initial 804 cases. The owner then expanded only corpus coverage to 855 and reran the conformance and ordinary Node tests.

The next local increment implements internal profile/project/preferences persistence and task-start reservation, lookup, completion and pending-only clearing. A **16-step committed Node trace** compares returned documents, exact persisted JSON, row identities and path keys. Unknown properties remain intact; project updates preserve their original path key and rowid; profile replacement matches the existing Node replacement behavior. The task-start tests retain failed/unknown records and prove restart changes pending to unknown without recreating a task. These are Store prerequisites, not executable RPC handlers. RPC filesystem admission, project event publication, task/message mutation and fake-provider execution remain to be ported.

Workspace increment validation: locked restore and full Release build with zero warnings/errors; **5,298 solution tests passed, zero failed, one local registry-policy skip, 5,299 total**; all four focused workspace tests passed; ordinary Node oracle passed; `pnpm check` passed type checking, lint and **492 tests across 57 files**; `git diff --check` passed. Logs: `test-results/p2-workspace-{build,tests,all-tests,node-tests,pnpm-check}.txt` and `test-results/p2-final-restore.txt`. Independent security and data reviewers, both existing GPT-6 Luna/max leaves selected through the supplied AGENTS.md Critical lane approved tuple, accepted the exact production delta and each passed all four focused C# tests. Security also passed the ordinary Node oracle. The owner fixed a test gap: an instance-local, loop-guarded path-key probe seam now makes the off-loop regression fail if a path probe runs before affinity rejection. The final reviewed production SHA-256 is `05C119CE4C341859566CD6F36954A8F39B70AA820C60978CA5B6576CDEB775BF`; the immutable workspace corpus SHA-256 is `E791E80979C8B5B88164BA33C31A91997654B797B2C9F131EB5D1600E45CA96E`.

Security review withdrew a proposed schema gate inside the low-level path-key helpers after checking the TypeScript migrations: those helpers intentionally run after v3 DDL but before the cached schema version changes. The C# methods have no production call sites yet. Future service handlers must preserve the existing order: schema admission, lexical network/device refusal, canonical/mapped-drive checks, then Store access. No shipping security defect or dual-implementation hotfix was established by this increment.

Rudy's native Hub reply `call_281d99e2f5894e51859d9675aca95be7` authorized publication and Windows CI **only** for the reviewed security/workspace increments at [c2e7b44](https://github.com/koala-man-64/foundry-agent-workspace/commit/c2e7b442b6df6ab1ca355124643a43523d3d49d4). The owner verified the human reply, pushed that exact hash, confirmed the remote head, and dispatched [Windows CI 38392798527](https://github.com/koala-man-64/foundry-agent-workspace/actions/runs/38392798527) against the identical source. The run **passed: 5,299 tests, zero failed or skipped; locked restore and zero-warning/error Release build**. This includes the ephemeral registry-policy gate. The sole owner watch exited successfully; no pending CI monitor remains. The remote head was reverified as the authorized hash after the newer local increments were committed. Those later task/message/fake-provider changes and this evidence amendment remain unpublished and excluded from this exact-source authorization. Full hosted log: `test-results/p2-windows-ci-38392798527.log`; receipt: `test-results/p2-publication-ci-receipt.json`.

### Local task/message persistence continuation

Local P2 implementation continues independently of the external publication gate. Internal task saves now preserve archive omission/null/empty semantics, update read projections and generation counters, retain unknown JSON, and emit the existing lifecycle/root events. Message saves preserve rowids and global ordinals while atomically maintaining redacted FTS rows, generation counters and completion events. `tests/p2/task-store-vectors.json` pins **22 steps across seven scenarios**: fresh data and disposable copies of all six actual fixture eras, including uncheckpointed WAL. Ordinary Node/C# tests read committed expectations and never regenerate them. Additional faults cover outer/nested rollback, a failed search-projection update, committed task/event authority after notification failure and loop-affinity rejection. No executable handler or adoption operation uses these internal methods yet.

Validation of the combined local continuation: zero-warning Release warnings-as-errors build; **5,338 solution tests passed, zero failed, one local registry-policy skip, 5,339 total**; `pnpm check` passed type checking, lint and **494 tests across 59 files**; `git diff --check` passed. The focused task suite passed **10/10**, and its ordinary Node oracle passed **1/1**. Independent data review accepted exact `Store.Tasks.cs` SHA-256 `60DEDC881499FA76B0F139D893EB22280C0EAC1A748977161EA8FD49BE4C6C8E`; independent security review accepted the same source and the offline fake-chat candidate. Both used existing GPT-6 Luna/max leaves selected by the supplied AGENTS.md Critical lane approved tuple; no new implementation owner was created. Logs: `test-results/p2-task-store-{build,tests,node-tests}.txt`, `p2-task-fake-all-tests.txt` and `p2-task-fake-pnpm-check.txt`. Reviewers used disposable copies and opened no original fixture SQLite database.

### Local offline fake-chat continuation

`Foundry.Providers.FakeChatProvider` implements only the offline no-tools text/continuation slice. It has no profile verification, tool execution, credentials, network, paid-provider or fallback path, and is not yet the complete provider adapter or an executable task handler. Provider-internal typed records stay in the Providers assembly; frozen protocol source is unchanged. **28 committed Node cases** pin last-user selection, empty text, opaque continuation preservation/validation, UTF-16 12-unit chunks (including split lone surrogates), exact errors and default abort outcomes. Node's final-text cancellation quirk is preserved: cancellation between the final yield and timer-listener setup can still be followed by `done`. This is existing provider behavior, not evidence that runtime task cancellation is correct. Runtime cancellation and reservation settlement must be ported and tested before binding executable handlers.

The fake-chat suite passed **30/30** C# tests, including controlled pending-pause cancellation, continuation affinity on the RuntimeLoop and early disposal without starting a pause. Its ordinary Node oracle passed **1/1**. The combined local checks above cover the exact candidate; independent security review passed the two focused C# suites **40/40** and both Node oracles **2/2**. Reviewed `FakeChatProvider.cs` SHA-256: `0589CB5AD9F1110808E4FA26A49BAAF8DBF0DEE72F3F3D218BF5C11069443F50`. Logs: `test-results/p2-fake-chat-{build,tests,node-tests}.txt`. No new dependency or global analyzer suppression was introduced. These newer task/message and fake-chat increments remain local and excluded from the exact-source publication approval above.

### Local context and measurement validation

The stateless `RequestAccounting` prerequisite reproduces byte-based context/reservation estimates and revalidates injected provider usage. It uses the compatibility serializer with the existing fixed context-field order and omission rules, includes native continuation/tool results, adds the existing 512-byte allowance and output reservation, and preserves strict `>` limits and context-before-task-budget error order. Unsafe, fractional, negative or nonnumeric input/output totals remain unknown; invalid optional subsets are omitted, and overlapping cache subsets are both omitted. It assumes validated profile/task contracts and introduces no executable admission or ledger mutation.

**469 committed Node cases** plus three nonfinite injection tests passed **472/472** focused C# tests and the ordinary Node oracle. Independent data review accepted the exact source after the owner added six dual-failure vectors proving context error precedence. `RequestAccounting.cs` SHA-256: `623212B994B0FB77E774382CD4EC5BCCA4E7648EF21A7973C6494C0B57A459BE`; corpus SHA-256: `DB30D954F132D6432600703E6FF1102066B3BDBF7D477701CC89776F771E5467`. Final combined local solution: **5,810 passed, zero failed, one local policy skip, 5,811 total**; `pnpm check`: **495 passed across 60 files**, with type checking/lint passed; zero-warning Release build and `git diff --check` passed. Logs: `test-results/p2-accounting-{build,tests,node-tests,all-tests,pnpm-check}.txt`. This continuation remains local and outside the c2e7b44 publication authorization.

### Local persisted usage lifecycle

Internal Store primitives now reproduce request admission, first-attempt marking, one-time terminal settlement and identity lookup. New request tracking remains disabled before schema v4, including reservation validation, while identity lookup checks retained legacy usage records in those eras; supported eras reject unsafe, negative, fractional or nonfinite reservations. Attribution snapshots the existing root title with the TypeScript fallback rules, and settlement preserves known usage on cancelled/failed requests. The existing restart recovery marks unfinished requests interrupted without replay. These primitives do not themselves reserve or settle task budgets, normalize measurements, dispatch inference or expose a handler; their eventual caller must perform those operations atomically with the ledger.

`tests/p2/usage-store-vectors.json` pins **26 operations across seven disposable-copy eras**, including uncheckpointed WAL and a pre-existing legacy usage record. The C# focused suite passed **11/11**: era traces plus outer/savepoint rollback, duplicate admission rollback, authoritative commit despite publication failure, nonfinite rejection and loop-affinity checks even on a disabled ledger. The ordinary Node oracle passed; expected results are regenerated only under the explicit development flag. Final corrected source passed zero-warning/error Release build, **5,821 solution tests with zero failures and one expected local policy skip (5,822 total)**, and `pnpm check` with **496 tests across 61 files**, type checking and lint. `git diff --check` passed. Logs: `test-results/p2-usage-{build,tests,node-tests,all-tests,pnpm-check}.txt`. The oracle's invalid draft role was corrected to the actual `child` enum. Independent data review found a legacy lookup mismatch; the owner fixed it against the actual Store wrapper, added the retained-record regression and reran affected checks. The existing read-only GPT-6 Luna/max reviewer (AGENTS.md Critical route, selected for independent persistence/concurrency evidence) accepted the exact corrected source and reran focused tests **11/11** plus the ordinary Node oracle **1/1**. Source SHA-256: `521FFDBD778C46BC9B40FAEAC87359D5085F095A704BEEB29A26E452B4C0BA57`; corpus SHA-256: `4101B9ED2962C067E5AD3DA2C7D47CAF84ABF51E66A3943AC32DFAF979E4A6BF`. No original fixture database was opened. This increment remains local and outside the earlier exact-source publication approval.

### Local bounded message-history projections

Internal `MessagePage` and `MessageContent` reproduce the existing query projections without exposing an RPC handler. They take already-validated parameters, use task-scoped SQL, redact content before clipping, preserve unknown metadata and source rows, and retain the existing high-water/before cursors and ordering. Pages use the **256 KiB minus 1 KiB** item allowance and **4 KiB** excerpts; content chunks retain the **64 KiB** request maximum, UTF-8 alignment and fallback behavior, and halve escaped chunks until the **256 KiB** response cap is met. These reads never grant provider, repository or tool authority.

**106 committed Node query outcomes** cover seven disposable fixture eras: empty/missing tasks, cross-task content denial, cursor stability, secret redaction, exact item-cap acceptance and one-byte-over refusal, partial-page continuation, multibyte boundaries, offsets inside code points, lone surrogates and JSON-escape expansion. The focused C# suite passed **7/7** and verifies unchanged retained rows plus loop affinity; the ordinary Node oracle passed **1/1**. Final Release build had zero warnings/errors; solution tests passed **5,828 with zero failures and one expected local policy skip (5,829 total)**; `pnpm check` passed type checking, lint and **497 tests across 62 files**. `git diff --check` passed. The existing GPT-6 Luna/max read-only data reviewer (AGENTS.md Critical route, chosen for independent data/read-projection evidence) accepted exact source SHA-256 `9FA9D87FF0A8DFCB4D2426CEBB765FA8EB987F9C253B2923301E825C2A6B19AB` and corpus `E7B685A6DB8F6321914ED73198D4DBF9CFA3254AE61640680018877AF2C84046`, independently running the focused suites. No original fixture database was opened. Logs: `test-results/p2-messages-{build,tests,node-tests,all-tests,pnpm-check}.txt`. This increment remains local and outside the earlier publication approval.

### Local atomic single-task request accounting

Internal admission now reserves an ordinary task's conservative budget and inserts its request in one transaction. Terminal accounting revalidates measured usage and commits the request/legacy usage record with its task-budget adjustment; invalid or absent measurements retain the reservation conservatively. Repeated settlement of the same request does not charge twice. Context and budget errors leave no partial mutation, and failed admission/settlement or outer transactions roll back the task, ledger and events together. Task/profile admission, metadata redaction/length checks, lifecycle status and notifications remain caller responsibilities; this is not the coordinated shared ledger or an executable provider handler.

The oracle pins **15 operations across seven disposable-copy eras**, using the actual TypeScript admission helper, legacy hooks and Store operations with the terminal transaction assembled from `AgentLoop.run`. It includes failure/cancellation usage, unsafe measurement fallback, budget/context refusal and restart. The post-recovery settlement probe exercises helper behavior only; it grants no replay authority, and pre-v4 recovery retains the existing generic unknown-usage semantics. Exact vectors exposed a C# parity defect in the order of generated legacy recovery IDs. C# now generates the usage-record ID before the request ID, matching TypeScript; the shipping implementation and expected results were not weakened or changed.

The focused C# suite passed **9/9** and the ordinary Node oracle **1/1**. Faults cover trigger-aborted admission and settlement, duplicate IDs, outer rollback, committed settlement despite delivery failure and loop-affinity rejection. Final Release build had zero warnings/errors; solution tests passed **5,837 with zero failures and one expected local policy skip (5,838 total)**; `pnpm check` passed type checking, lint and **498 tests across 63 files**; `git diff --check` passed. The existing GPT-6 Luna/max independent read-only data reviewer (AGENTS.md Critical route, selected for persistence/concurrency evidence) accepted source SHA-256 `48A3BD2A502558258E1B2B918094E5EB1CEC422AED4A546C2C8F988135F783DC`, recovery source `A3988C512267D2BA3A6A869ED5E0ECD9E6EF5C50C2C76D7F91015AF4150F6C1C`, and corpus `DE8D15987BBC9AFB372424CB1C6D192FB0EB1333189E5267A360D64970F4300D`, rerunning the focused suites. No original fixture database was opened. Logs: `test-results/p2-task-accounting-{build,tests,node-tests,all-tests,pnpm-check}.txt`. This increment remains local and outside the earlier publication approval.

### Local provider-facing retained history

Internal preparation reads preserve complete stored message documents and override any embedded ordinal with the durable SQL ordinal, map retained compaction ranges, and return opaque provider state without strict incoming-message parsing or rewriting. The pure history transform sends only complete messages, replaces ranges with their retained summaries, preserves stable range order and overlap precedence, handles duplicate IDs exactly, and merges a summary into a preceding user message with the existing separator. These are internal provider preparation reads; public history remains paged through the bounded projections above. They do not validate or execute native continuation, grant tool authority, check profile fingerprints, or dispatch inference.

**144 committed Node transform cases** plus **seven disposable-era read projections** passed **151/151** focused C# tests and **2/2** ordinary Node oracles. Coverage includes incomplete/missing status, input ordering, same-start overlapping ranges, case-sensitive and duplicate identities, empty summaries, unknown properties, SQL-ordinal precedence, opaque native data and lone surrogates. Read tests confirm unchanged source rows and independent returned copies; Store methods reject off-loop access. Final Release build had zero warnings/errors; solution tests passed **5,988 with zero failures and one expected local policy skip (5,989 total)**; `pnpm check` passed type checking, lint and **500 tests across 64 files**; `git diff --check` passed. The existing GPT-6 Luna/max read-only data reviewer (AGENTS.md Critical route, selected for independent persisted-data/history evidence) accepted the exact candidate and independently reran focused tests. Source SHA-256: `Store.History.cs` `F1BDC8B9A3C81F6992EB283522D64B61BDEA1952BC7C7B7078DBE327308E7ED3`; `ProviderHistory.cs` `30F8D5A5F990A82957134A7BE90057BAF9CEFEDD16F6473013370325856CDC14`. Corpus hashes: `2EF7E8D3DFAF89497A46C4756EDDCBD209A778809927FE8ED233E29B1866A544` and `757B651F596C9C187A1AB3B623FA094D41E3AFAD72C27EA224FE212EDF84232B`. No original fixture SQLite was opened. Logs: `test-results/p2-history-{build,tests,node-tests,all-tests,pnpm-check}.txt`. This increment remains local and outside the earlier publication approval.

### Local ordinary-chat request preparation

Internal chat preparation reproduces the native-state fingerprint gate before the blocking-unknown gate, reads approval status from SQL rather than retained JSON, preserves existing browser-acknowledgment truthiness, and replaces unfinished calls with a retained result or an explicit interruption error without replay. Otherwise it builds complete-message history with retained compaction summaries and appends the new user content. Opaque continuation and stored rows remain unchanged. This supports ordinary chat without browser/channel/MCP/tool advertisement; caller profile/capability admission and runtime execution/cancellation remain separate.

Independent data review found that the first candidate rejected an omitted optional task mode. The owner fixed the legacy-chat path and doubled the corpus to **96 cases across seven disposable eras (672 outcomes)**, retaining explicit unsupported-mode and parent-task rejection. The corrected candidate passed focused C# **7/7**, ordinary Node **1/1**, zero-warning/error Release build, **5,995 solution tests with zero failures and one expected local policy skip (5,996 total)**, and `pnpm check` with type checking, lint and **501 tests across 65 files**. `git diff --check` passed. Existing GPT-6 Luna/max read-only security and data reviewers, selected by the AGENTS.md Critical route for independent admission/persistence evidence, accepted corrected source SHA-256 `C86123800D22C12F5FA92EF9D46BFB4625B697DE43A7B4E4A2B5259AFD43F0C3` and corpus `555F01D7CB3B5A212BDD5C221B9552580FEA3415B4252B8997384E80A7361247`, independently rerunning focused checks. No original fixture SQLite or live provider was accessed. Logs: `test-results/p2-preparation-{build,tests,node-tests,all-tests,pnpm-check}.txt`. This remains local, with no new executable handler and no additional publication authority.

### Local development fake-chat execution

The explicit development opt-in `FOUNDRY_RUNTIME_P2_CHAT=1` now enables `task.start`, `task.send`, `task.cancel`, `task.read`, `task.messages` and `task.messageContent`, alongside `workspace.summary`, in `Foundry.Runtime.exe`. Explicit isolated data configuration remains mandatory. Without the opt-in, the executable retains its P1 summary-only behavior. This slice admits only ordinary projectless chat with the offline fake profile; known unsupported operations return bounded errors before executing a partial handler. Repository-backed/child tasks, external profiles, unresolved mutation intents, incompatible fingerprints and later native stages cannot admit a provider request. No Electron selector, real-data access, tools or live provider are enabled.

The service preserves exact request-ID/hash coalescing and retained start-intent rules, atomic message/budget/request admission, three provider slots, loop-affine cancellation, conservative unknown usage and selected canonical notifications. Only the two approved JavaScript deferral sites queue work. EOF closes admission and cancels/drains owned turns under the existing process shutdown bound; output remains single-writer protocol traffic. A final provider completion after cancellation cannot become success. A postcommit notification failure closes admission at the earliest loop catch, signals fatal process shutdown and retains the authoritative mutation for conservative recovery. Independent data review found and the owner fixed an orphaned-start path, a queued-start ordering gap and an incorrect failed marker on a committed retry. These were C# port defects; no shipping TypeScript defect or dual-implementation hotfix was established.

Validation: **30/30 focused C# execution/process tests**, including six copied fixture eras (v1/v2 refuse creation; v3–v5 execute without an upgrade), coalescing/conflicts, controlled slot cancellation, malformed/oversized provider streams, three committed-delivery faults, early admission denials, fragmented Unicode, batched replies and immediate EOF. A committed **ten-step Node service trace** agrees on exact stored rows, notifications and returned values. An additional **actual Node/C# stdin/stdout process differential** passes, normalizing only generated identities and wall-clock timestamps; nondeterministic progress is asserted separately. Run this explicit gate after both builds with `pnpm exec vitest run --config tests/p2/process.config.ts`; ordinary Node checks do not acquire a .NET dependency or silently skip this gate. Ordinary tests never regenerate expected corpus files.

Locked restore and Release warnings-as-errors build pass with zero warnings/errors. Final solution tests pass **6,025, zero failures, one expected local registry-policy skip (6,026 total)**. `pnpm check` passes type checking, lint and **502 tests across 66 files**; `git diff --check` passes. The unchanged Electron/TypeScript user paths pass **21/21 E2E tests**, local package creation and package/expansion smoke. Those are shipping-baseline evidence; they do not establish Electron+.NET or complete P2 smoke parity. Current logs and focused results are in `test-results/p2-execution-{build,dotnet,node,focused,process-parity,package-smoke,e2e-retention}.*`. Both existing read-only independent reviewers accepted the final service hash: **GPT-6 Luna/max**, selected through the supplied AGENTS.md Critical approved route for security and persistence/concurrency evidence. Security independently exercised the focused process/loop tests and real process differential before the final bounded catch change; both reviewers inspected that final change and regression, with final testing retained by the owner. No new reviewer was spawned. Intentional FULL durability and publication after outermost commit remain unchanged. The execution corpus SHA-256 is `B755B863DEDAFCB9A2D1C5078DE07D9733EC34C665BF8F2424A8C6D2675F4769`; reviewed service source SHA-256 is `AE10DD6B326733B663E3C5B5C56BF36DB99936B509EEEB622C9A5F2D09C8C3FE`.

**Artifact retention correction:** the first baseline E2E run used Playwright's default output directory and cleared older ignored `test-results` receipts, including local raw logs/fixture-review side effects. Committed spike results, corpus/fixture bytes and source records remain intact. `playwright.config.ts` now confines automatic cleanup to `test-results/e2e`; a focused workspace rerun passes and preserves the current receipts. Published P1 and P2 Windows logs/receipts were fetched again from their original successful provider runs without dispatching CI. The unavailable older local bytes are not represented as restored evidence.

### Local workspace/task/event read pages

Six further complete query handlers are bound in the same explicit development opt-in: `workspace.profiles`, `workspace.projects`, `profile.read`, `workspace.tasks`, `workspace.events` and `task.timeline`. Profile/project pages retain the 128 KiB budget; single-profile reads retain 256 KiB; task/event pages retain 256 KiB minus the 1 KiB metadata allowance. The parameterized helper preserves `workspace.summary`'s independent 25-item/96 KiB budgets. Task pages preserve legacy/current archive and child filtering, fixed-order filter hashes, cursor/high-water behavior, recent-first-page refusal, and the historical legacy locale ordering. Events preserve legacy/runtime tags, omission, root/child timeline scope, malformed-data screening and redacted 4 KiB payload limits. Stored documents and source rows are not rewritten by reads.

The committed Node vectors compare all six methods across **seven disposable eras** and include exact page limits and one-byte-over refusals, partial pages, mixed-case identities, cursor conflicts, unknown fields and malformed/secret/oversized events. Both harnesses materialize numeric project directories solely inside their checked disposable roots, rewrite only copied project `data.path`, and normalize only returned paths to the unchanged golden contract. Removing a checked private project directory produces the raw unavailable result. Independent data review found this portability issue before acceptance; expected corpus results were not weakened. Both Node and C# verify unchanged task/event/profile snapshots after every query. The actual executable differential now exercises all six queries as well as the fake-chat path.

Final validation: zero-warning/error Release build; **6,032 solution tests passed, zero failed, one expected local registry-policy skip (6,033 total)**; **7/7** copied-era C# comparisons; ordinary Node oracle and the expanded actual-process differential passed; `pnpm check` passed type checking, lint and **503 tests across 67 files**; `git diff --check` passed. Evidence is retained in `test-results/p2-pages-{build,dotnet,node,node-oracle,focused,process-parity}.*`. The preceding 21-test Electron/TypeScript and package/expansion-smoke baseline applies to unchanged shipping source; no Electron+.NET proof is inferred.

Independent data review accepted the exact production source; the existing security reviewer found no new execution/data authority and accepted the local parity scope with two inherited residuals. Both reviewers are the existing **GPT-6 Luna/max** read-only leaves selected through the supplied AGENTS.md Critical approved route; no new spawn occurred. Owner validation retains the final tests. Source SHA-256: `Store.WorkspacePages.cs` `879B79E2864288FE306C24907596F1F45F6F100E08E1A202D539E8568AB6DB43`; `Store.Summary.cs` `267D017C7A4BBE0AFA41C38AE22E125CEEE6F7ABA6C7311584CCAA3A6721E0D9`; `DevelopmentChat.cs` `35D5341C1BD2023503350745D42F3982CC4AC264D865FBF0F1CFFF3EC33168CF`. Corpus SHA-256: `EA3D8821302E4AAB8FE9AA42364C498289EA6F176EB5E4C306C26D8C36814886`.

**Shared residuals for further P2 security qualification:** pre-v5 task pages currently parse/sort all retained tasks, so response size is bounded but work and memory remain O(n), as in TypeScript. A compatible dual-runtime bounded-memory correction and larger disposable-store coverage remain follow-ups. Project listing rejects literal UNC/device paths before probing but inherited local reparse/mapped-path probes can still reach a redirected location before final-path rejection. This is not a universal no-network guarantee. This entry used to say that the approved plan accepts user-chosen mapped-drive resolution. It does not: decision 8 refuses a project on a mapped network drive, and Rudy confirmed on 19 October 2026 that network and mapped network drives stay refused (see "Drives" under the reconciliation items below). The plan's only mapped-drive note is a residual of the path-key computation, which opens the path. Reparse-to-UNC probing remains a distinct shared security residual for the filesystem slice. No real data was opened and no network path was probed by this increment. Full P2 security acceptance is not established by these parity tests.

### Dual-runtime legacy task-page memory correction

The legacy-memory follow-up above is now corrected in both implementations. Pre-v5 task pages stream every stored row and keep only the best `limit + 1` candidate documents, plus the current row/transient insertion, rather than retaining the complete history. Stable locale ordering, cursor filters, cursor-independent high-water selection, omission, page-byte limits and malformed-data errors remain unchanged. The scan still takes O(n) time; candidate memory is O(limit) documents, not a universal byte bound, because an individual persisted row is still parsed before the page budget check. The C# reader stays on its owning loop and disposes its command/reader on success or failure. The v5 indexed query path is unchanged.

**Migration correction record:** this resource-availability improvement is dual-landed in the local TypeScript and C# candidates, without adding an API, schema, dependency or intentional wire difference. The existing workspace-page corpus remains byte-for-byte unchanged. A new independent reference uses the previous whole-history algorithm over **20,000 rows in each of v1–v4** and pins full-output hashes/IDs for **ten pages per era**; a malformed final row still fails instead of being skipped. Cleanup checks prove subsequent commands work and disposable directories remain removable. The Node regression also refuses an accidental call to `allTasks` from the production query.

Validation: **11/11 focused C# tests** (four large-history eras plus seven existing page comparisons), Node focused **2/2**, zero-warning/error Release build, **6,036 solution tests passed, zero failed, one expected local registry-policy skip (6,037 total)**, and `pnpm check` with type checking, lint and **504 tests across 68 files**. Actual Node/C# process parity, **21/21 Electron E2E**, local package creation and package/expansion smoke pass on the corrected TypeScript candidate. These user-path/package results cover Electron+TypeScript; Electron+.NET remains unqualified. `git diff --check` passes. Logs and focused results: `test-results/p2-legacy-memory-{build,focused,node-focused,page-tests,dotnet,node,process-parity,e2e,package,package-smoke}.*`.

Both existing **GPT-6 Luna/max** read-only security and data reviewers, selected by the supplied AGENTS.md Critical approved route, accepted the exact production delta; data independently passed the large-history Node and C# tests. Source SHA-256: TypeScript `workspace-queries.ts` `EE395B282325C99775EBC081BB9AFDCC9A0160A275B05981BD982787A9D76DE9`; C# `Store.WorkspacePages.cs` `42A4A1AA4437C9AEAB3B2D16BED9E147F44EC7DDDC5D5FAE44DBECADD254F34C`. New corpus SHA-256: `0DCB085FCE395ABC3295EFB55794D1EABDC6BD126859C9A0188E0F918105DC74`. No original SQLite fixture was opened. The separate reparse-path security residual remains open for the filesystem slice; FULL durability and publication after commit remain the only approved intentional compatibility differences.

These increments do not establish the complete P2 security gate. Remaining Store/projects/tasks query/service surfaces precede Git/files, commands/approvals, Azure providers, MCP, orchestration, automation/continuity/usage/channel and browser tools in plan order. P2 exits only after both-runtime security suites, deterministic differential traces and the specified Electron+.NET E2E/smoke gates pass. Retain the approved **16–22 week** P2 planning range; refine it after the first complete Store/projects/tasks slice. Main integration, adoption, live-provider calls and production remain held. Newer local increments remain unpublished; the earlier exact-source publication approval does not extend to them. External publication boundaries do not prevent independently authorized local implementation.

### Local retained usage and compaction reads

The opt-in isolated development runtime now serves `task.usageRecords`, `task.compactions` and `task.compactionContent`, in addition to the thirteen existing methods. These are read projections only: they neither execute compaction nor grant approval, provider or repository authority. Usage pages preserve the legacy ledger shape, current finished-request outcomes, coordinated-root child aggregation, rowid cursors and redacted reason clipping. Compaction pages retain their ordinal/count/token fields, bounded summaries and byte cursors; opaque provider state remains stored and absent from public output.

The committed Node corpus contains **109 requests in each of seven eras (763 outcomes)**, covering absent/foreign tasks, pagination, unfinished requests, legacy/current usage, redaction, supplementary Unicode, offsets within UTF-8 sequences, embedded NULs, oversized escaped content and EOF. Every query checks that task, usage and compaction rows remain unchanged. C# fixture copies seed raw summary bytes with `CAST(... AS TEXT)` because the .NET string parameter binder truncates embedded NUL text; production reads decode SQLite's counted UTF-8 bytes rather than the NUL-terminated string conversion. This corrects a C# port mismatch; it does not require a TypeScript hotfix. Direct raw-string writes containing NUL must use explicit counted-byte/TEXT binding when later compaction writes are ported. The corpus and opaque state are not rewritten to accommodate the port.

An additional C# process lifecycle correction observes unexpected handler faults while stdin remains open. The owning loop closes admission and cancels active fake responses before signalling failure; queued mutations cannot start afterward. Both P1-default and P2-opt-in regressions cover malformed persisted JSON and non-object documents and verify prompt nonzero exit, fixed redacted stderr, no misleading response and no queued task/ledger mutation. This closes an unobserved-task gap in the C# entry point, rather than changing the shipping TypeScript error handling. The existing shared message chunk algorithm remains byte-for-byte compatible, including replacement-character behavior when callers request an offset inside a UTF-8 sequence.

Validation: locked restore, zero-warning/error Release build, **49/49 focused tests**, **6,048 solution tests passed, zero failed, one expected local policy skip (6,049 total)**, and `pnpm check` with type checking, lint and **505 tests across 69 files**. The actual Node/C# stdin/stdout differential includes usage pages, empty compaction pages and ownership errors. A seeded process test verifies content retrieval, UTF-8 fallback, ownership denial and omission of opaque state. All disposable directories remain removable. `git diff --check` passes. Logs/results: `test-results/p2-retained-read-{restore,build,focused,node-focused,dotnet,node,process-parity}.*`. Both existing GPT-6 Luna/max read-only reviewers accepted the exact final production hashes under the supplied AGENTS.md Critical approved route. Security reviewed bounds, ownership, opaque-state omission and fault shutdown; data independently passed 16 focused C# tests and the Node corpus. The owner retains integration and final process validation. Reviewed SHA-256: Store reads `E5AFD7C72947F12DE11E5CCE63A38564A808524D1C057A7148FE228FD8C99062`, counted-text Store `6CDB4032A620CE821B838DA0C312468CCEC15663C84D6C04CD9FD44F61F5D9EB`, development dispatch `FD0F37A0FE88C48404B5F6247400C43C1CDF34B6B550453683382A3C5F4700F9`, process entry `7D89A9FDB9C2A43D48B681987702E5587FC1D0C595DE2F36C566DE550C5F3531`. Fetching/redacting a retained field still uses memory proportional to that field, matching Node; bounded output is not a universal input-memory bound.

No TypeScript production, Electron renderer/supervisor or shipping packaging code changed in this increment. The previous exact TypeScript candidate's **21/21 E2E and package/expansion smoke** remain separate evidence; Electron+.NET qualification remains open. Corpus SHA-256: `F175B6EF9D42C71C8D05AC7808903BA581BDAB6800448B7DD5E8E9356722DAA6`. P2 remains incomplete; main integration, adoption, v6, paid providers, new publication and cutover remain held.

### Local archive/restore and feature admission

The opt-in development runtime now additionally serves existing `features.get`, `features.set` and `task.setArchived` contracts. The Store uses the existing v5 feature tables and keeps bounded, newest-first history; it does not migrate older eras. Pre-v5 snapshots report migration-required, feature writes are refused, archive admission is paused and restore remains available. Pausing archive blocks archive before task lookup; enabling it does not enable an automation engine. Hooks and scheduling admission are persisted settings only in this development slice; their execution engines remain deferred.

Archive/restore changes root-group visibility inside one synchronous transaction. Coordinated children follow their root; direct child changes are rejected. Repeated archives retain the timestamp, restore uses absent-field omission, and the existing empty/null rules remain unchanged. Task status, provider requests, approvals, unknown outcomes and opaque retained properties remain intact. Feature-state/history changes also share one transaction. Existing service notifications follow the state commit and remain separately durable; the approved publication-after-commit difference is preserved.

The committed TypeScript oracle pins **74 steps across seven eras (518 outcomes)**, including paused/restored behavior, child rejection, missing tasks, repeated calls, empty archive values, runtime-fault reasons, forbidden migration-required setters, default/legacy states and the 50-entry feature-history cap. A failure-injection test proves child cascade and feature-history errors roll back completely. A controlled fake-provider test archives and restores a running response while preserving its reservation and pending approval, then releases it to finish normally. Actual Node/C# process comparison covers archive, pause, denial, restore, feature snapshots, durable rows and notifications.

Validation: zero-warning/error Release build, **9/9 focused visibility tests**, **6,057 solution tests passed, zero failed, one expected local policy skip (6,058 total)**, clean `pnpm check` with **506 tests across 70 files**, actual process differential and `git diff --check`. Logs/results: `test-results/p2-visibility-{build,focused,node-focused,dotnet,node,process-parity}.*`. Both existing GPT-6 Luna/max read-only security and data/concurrency reviewers accepted these exact source hashes, selected by the supplied AGENTS.md Critical route for authority, persistence and concurrency risk. No new child was spawned; implementation and final validation stayed with the owner. This is passing local implementation evidence, not full P2 qualification. Original database fixtures remain unopened; scratch copies are removed. Source SHA-256: `Store.Visibility.cs` `084970327EA4843C8B28437E0D28080B067CA94DC4F5FBA6E36AE797CEE70BA2`, development dispatch `012008DB5601CF1C8934FB4BEDAB1EA380659060F4A302AAE31C9014F29EFE43`. Corpus SHA-256: `EF22A226E49A73E03FF702E26D45F8145927E9034B05269F06E9CB663EA0C562`.

P2 remains incomplete and is not ready to archive. Next are remaining bounded workspace queries and Store/projects/tasks service admission before the plan's Git/files and command/approval slices. The isolated development executable currently supports nineteen existing methods; Electron still ships TypeScript. Main integration, adoption, v6, external providers, new publication/CI and cutover remain held. No renderer, shipping selector or packaging code changed; prior exact TypeScript E2E/package results remain independent of the new C# process evidence.

### Local global Inbox projection

The opt-in isolated development runtime now additionally serves `workspace.actions`. Its fixed, parameterized SQL returns at most `limit + 1` candidates and computes global tier counts independently of the page cursor. The projection preserves TypeScript's decision/in-progress/recent tiers, stable timestamp/ID ordering, inclusive 30-day outcome cutoff, latest failed validation selection, draft classification and optional source-ID omission. Supported v5 records map child obligations to their root and retain archived-root visibility. Legacy eras keep their existing smaller candidate set without migration. This read never executes an action, grants an approval, dismisses an obligation or rewrites retained records.

The committed Node oracle traverses every page at limits **1, 2, 5 and 50** in fresh data and disposable copies of all six fixture eras. It covers archived-root child approvals, unknown/orphan/malformed intents, active/waiting runs, drafts, validation supersession and outcomes on both sides of the cutoff. Every read snapshots task, intent, event and applicable run/validation/draft rows to prove they are unchanged. Three additional NUL-bearing timestamp cursors per era match Node without a binding change. Ordinary tests only consume committed expectations; original fixture databases remain unopened and scratch directories are removable. The actual Node/C# stdin/stdout differential now includes the Inbox reply alongside its existing task, visibility, notification and durable-row checks.

Validation: zero-warning/error Release build, **7/7 focused era tests**, **6,064 solution tests passed, zero failed, one expected local policy skip (6,065 total)**, clean `pnpm check` with **507 tests across 71 files**, actual process differential and `git diff --check`. Logs/results: `test-results/p2-actions-{build,focused,node-focused,dotnet,node,process-parity}.*`. Both existing **GPT-6 Luna/max** read-only security and data/concurrency reviewers accepted the exact source and final corpus, selected by the supplied AGENTS.md Critical route for obligation visibility and persistence risk. No new child was spawned; implementation and final validation remained with the owner. Reviews inspected source and tests without opening original fixtures; automated results are owner evidence.

Reviewed SHA-256: Store projection `40C0C09ED51B1ADD5FC71FB4506CBBBD0CEF6208F45BB3AE6AABD3AF57864FB6`, development dispatch `E5718F485582D47BB1EB38D5A7DFE14569A7C01F3233587BC4A8F7DF6D1912C1`, C# corpus consumer `6AE71AA7FFABDBDFAD979B8F1F1B4571E403EFD35FBF9FB02B4F0202EF819E72`, Node oracle `B788EE2529944108978910E493E315943F5A3C35B6209B4BB00559E246A475D3`, corpus `3BD5B1D45AA7D246131B16DEA3A2AD3A692259F001A8ABDFF883B5F1F214BF1B`. The unchanged TypeScript query reference remains `EE395B282325C99775EBC081BB9AFDCC9A0160A275B05981BD982787A9D76DE9`.

The development executable now supports **twenty existing methods**, but P2 remains incomplete and is not ready to archive. Row-count paging is not a universal byte/input-memory bound: large persisted fields still follow Node behavior, and the process enforces its existing oversized-result error. Remaining workspace search and Store/projects/tasks service admission precede the ordered Git/files and command/approval slices. No renderer, shipping selector, production TypeScript or packaging code changed; prior TypeScript user-path/package receipts remain separate from this C# process evidence. Main integration, adoption, v6, live providers, new publication/CI and shipping cutover remain held. FULL durability and publication after commit remain the only approved intentional compatibility differences.

### Local workspace search

The opt-in development runtime now serves `workspace.search`. Legacy title searches retain JavaScript casing through the existing Unicode compatibility tables and the pinned locale ordering. Supported v5 searches use the existing SQLite title predicates and FTS message query, preserving their era-specific behavior rather than replacing it with a common case-insensitive .NET comparison. SQL filters and cursors are bound values; the filter fingerprint retains the exact JavaScript key order/null defaults. Title and message phases share captured task-rowid/message-ordinal high-water marks, preserve cursor omission and limit changes, map child message hits through their root, and apply the existing archive/project/mode/status/date filters. Message excerpts are redacted and clipped to 500 UTF-8 bytes; opaque retained state is absent from search results.

The committed Node oracle traverses limits **1, 2 and 50** across fresh data and disposable copies of all six fixture eras. It covers archive/root filters, locale/SQLite Unicode differences, exact ECMAScript whitespace, the eight-token FTS cap, quote/punctuation/NUL searches, trimmed inputs, redaction and UTF-8 clipping, mismatched filter hashes and empty high-water ranges. An explicit append-after-cursor case adds a later task and message and verifies the retained cursor excludes them. Source task/message/FTS rows remain unchanged around each read. The frozen contract accepts a NUL-only query; when it reaches FTS, Node reports `unterminated string`. C# maps only the same NUL-query, SQLite-code-1, exact pinned FTS error to the bounded RPC error; other database exceptions remain unexpected failures. Actual Node/C# stdio testing proves phase continuation, that error and a successful subsequent request.

Validation: zero-warning/error Release build, **7/7 focused era comparisons**, **6,071 solution tests passed, zero failed, one expected local policy skip (6,072 total)**, clean `pnpm check` with **508 tests across 72 files**, actual process differential and `git diff --check`. Logs/results: `test-results/p2-search-{build,focused,node-focused,dotnet,node,process-parity}.*`. Both existing **GPT-6 Luna/max** read-only security and data/concurrency reviewers accepted the exact final source/tests/corpus under the supplied AGENTS.md Critical route. No new child was spawned; the owner retained implementation and final validation. Reviews inspected source/tests without opening original fixtures; automated results are owner evidence. Disposable directories remain removable.

Reviewed SHA-256: Store search `AFB4DB2B0E477E0D940ADFCB65D60D72424B624498BCF709BCB764A98E86DDC0`, development dispatch `4889487E31C60C2C76810C384EBBABC0F41932986DF4E9A24CBCD8E2F1D37F4B`, C# corpus consumer `8B2EC89236A55F74010A1BD4E2BED9BE3E12DBDDFEECBBB71422316236D42B16`, Node oracle `C23168693C71B3C7206926D8556390CB27090CD90A6C0A8C86C1FF9F9C363471`, corpus `CC1FDFB287597414A65269FD5DDBCCC28341F86309C555A93353E935D90014CE`. The unchanged TypeScript query reference remains `EE395B282325C99775EBC081BB9AFDCC9A0160A275B05981BD982787A9D76DE9`; the reused case helper remains `7A95FD733374A342966D6C54BA28E673325115B449D4FC3AD246FF6D39B4316A`.

The development executable now supports **twenty-one existing methods**; P2 remains incomplete and is not ready to archive. Legacy search still scans and sorts the full title history in memory, matching Node; the separate task-list memory correction does not cover search. Result/row-count limits are not universal input-memory limits, and the process retains the existing oversized-result envelope. Remaining usage-trend projections and Store/projects/tasks service admission precede the ordered Git/files and command/approval slices. No shipping TypeScript, renderer, supervisor selector or packaging code changed; previous exact TypeScript user-path/package evidence remains separate from this C# process qualification. Publication/CI, main integration, adoption, v6, live providers and cutover remain held. FULL durability and publication after commit remain the only approved intentional compatibility differences.

### Local usage-trend projection and fractional-date correction

The opt-in development runtime now serves `workspace.usageTrend`, bringing its executable surface to **twenty-two existing methods**. Current and legacy ledgers preserve day/profile/task grouping, coordinated-root attribution, known/unknown/pending/not-sent classifications, cache observations, reserves, filters and cursor omission. Reads leave source task and ledger rows unchanged. Both runtimes normalize validated UTC timestamps to ordinal instant keys by removing the terminal `Z` and trailing fractional zeroes only; they do not round through floating-point or calendar conversions. Exact SQL bounds follow an indexable whole-second window. Independent assertions cover equivalent spellings, arbitrary precision, reversed ranges, midnight, year 0000 and year 9999 before comparison with the committed Node corpus. Ordinary tests never regenerate expected results.

Validation on the corrected source: Release build **zero warnings/errors**; **7/7** focused era comparisons; **6,078 solution tests passed, zero failed, one expected local policy skip (6,079 total)**; clean `pnpm check` with **509 tests across 73 files**; actual Node/C# process differential **1/1**; Electron/TypeScript E2E **21/21**; package creation and package/expansion smoke **PASS**; `git diff --check` clean. Logs are retained under `test-results/p2-usage-trend-*`. Electron/TypeScript user-path and package evidence remains separate from C# process qualification; Electron+.NET is not qualified by these checks.

The existing independent **GPT-6 Luna/max** security and data/concurrency reviewers accepted the final bounded implementation. Selection source: the supplied AGENTS.md Critical approved route; reason: independent persistence, time-bound accuracy and process review. No new child was spawned; the owner retained implementation and final validation. Data review was static. Security review independently passed the Node oracle **1/1**, C# era tests **7/7** and rebuilt process differential **1/1**. Accepted SHA-256 identities: TypeScript `workspace-queries.ts` **BF85E944B15FC8E780CE1F51DADDA91813AFD1F36EB6629EA43AF71FDBAB4B47**; C# `Store.UsageTrend.cs` **EAE3FD33DB1960E7875AA12423AA2CF94B0254D4C4393378694C4A0C5604E7F2**; corpus **364958D9D1D283224755DF08BD18225D700B91135AA4FA72C85754A801DB4F42**.

P2 remains incomplete and is not ready to archive. Remaining Store/projects/tasks service admission precedes ordered Git/files and command/approval slices. Legacy full-history search and large retained-field reads still have proportional input-memory costs; response limits are not universal input-memory limits. The local-reparse network-probe residual remains open. No renderer, supervisor selector, schema or packaging code changed. Publication/CI, main integration, real-data adoption, v6, live providers and cutover remain held. FULL durability and publication after commit remain the two approved intentional compatibility differences; this explicitly authorized accuracy correction is shared by both runtimes.

### Local Store/projects/tasks service admission

The opt-in development runtime now serves `project.update`, `workspace.preferences.save` and `workspace.schema`, bringing its executable surface to **twenty-five existing methods**. Saved-project name/visibility updates preserve unknown persisted properties, rowid and the original path key without probing the saved path. Preference updates merge omitted fields, validate referenced profiles/projects, allow the existing `none` grouping, preserve unknown properties and deduplicate collapsed IDs in first-occurrence order. Both mutations require schema v3 or newer, preserve the existing backed-up-upgrade error on older eras, and commit their durable notification event with the state change. Schema reporting never upgrades data; `coordinatedAvailable` is explicitly **false** for this incomplete C# slice. The process comparison asserts this deferred capability against Node's available orchestration and compares the remaining schema fields; it does not report full-runtime capability parity.

Admission remains atomic: `project.add`, Git-backed `task.create`, `workspace.upgrade` and project-backed/coding/coordinated `task.start` execute no partial handler, path probe, task-start reservation or project/task/intent write. Existing projectless ordinary fake-provider execution remains supported. Repository inspection and worktree creation must land together with their complete handlers in the ordered Git/files slice; model configuration/probing and provider authority remain deferred. No real data, schema v6, renderer or supervisor selector changed.

The committed Node service corpus records **84 transitions across seven disposable eras**, including missing references, empty updates, trimming, visibility, omitted fields, deduplication, unknown-field preservation and unchanged project path keys/rowids. Fault injection covers both mutations' state/event rollback and committed-event retention after delivery failure. Controlled awaits prove queued orchestration cannot create a child, hold or intent after close, and completed real script-pin validation cannot launch a queued script after close. Already-admitted provisioning retains its conservative recovery path. Off-loop calls fail before Store access; disposable directories are removable after owning-loop shutdown. The TypeScript data-integrity and lifecycle corrections are listed in the dual-landed hotfix list above.

The existing **GPT-6 Luna/max** read-only security and data/concurrency reviewers accepted this bounded implementation. Selection source: the supplied AGENTS.md Critical approved route; routing reason: independent persistence, concurrency and lifecycle evidence. No new child was spawned; the owner retained implementation and final validation. Data review was static. Security independently ran the seven Node admission/fault tests and earlier C# era/process checks; its subsequent fixture/comment review was static. Accepted production SHA-256 identities: C# `Store.ServiceAdmission.cs` **335CF7939111F0A4A95CAE9BA9FD8E8F063F35ED0BC11F6BCD7BB3AF0AF23A6D**; TypeScript `service.ts` **F88D17EC219671E6C1ABEDEFF7D2647F647F8F8C7B2E682C97CDC1ED3F29B30B**, `orchestrator.ts` **F6FCE76B3B85FBDACAA025E13F03020FA390416556028C5F9B7A1FF5325E7E16**, `automation.ts` **40560BDC7DF32EBDEE396F7E7A0FA05F8EE0B5A5F0A0969F89E253EC1ABA59E3**. Corpus SHA-256: **6323A115A2A734DB219707ADC93CEABB07FF12940014355666B37D49BF1E7B43**.

Final validation: Release build **zero warnings/errors**; **11/11** C# admission/era/fault tests; **6,089 solution tests passed, zero failed, one expected local policy skip (6,090 total)**; clean `pnpm check` with **516 tests across 74 files**; **7/7** focused Node admission tests and **8/8** trace tests; rebuilt actual Node/C# process differential **1/1**; Electron/TypeScript E2E **21/21**; package creation and package/expansion smoke **PASS**. Evidence: `test-results/p2-admission-{focused,dotnet,node-final,process-final,e2e-lifecycle,package,package-smoke}.*`. Electron/TypeScript user-path/package proof remains separate from C# process proof; this is not Electron+.NET qualification.

Earlier failures are preserved rather than replaced by the final pass: the first E2E run passed 20/21 and failed to activate a focused grant button with Enter at 200% zoom; its focused retry passed. The second passed 20/21 but recorded an empty coordinated Git integration. Their exact causes remain unconfirmed; the final rebuilt sequential E2E run passed both unchanged tests. Logs and traces remain in `test-results/p2-admission-e2e*.txt`, `test-results/e2e` and `test-results/p2-admission-e2e-final`. A full Node run also exposed a trace-fixture race between independent stdout/stderr pipes. Its diagnostics now use a separate request and an observed-stderr handshake before the next frame; all frames, exact normalization, redaction, oversized-input and EOF assertions remain. That deterministic test correction was independently accepted; the final full Node suite passed. The expected local registry-policy skip does not establish the ephemeral Windows CI gate, and no new CI was dispatched.

P2 remains incomplete and is not ready to archive. Main integration, publication/CI, real-data adoption, v6, live providers and cutover remain held. The local-reparse network-probe residual and proportional input-memory costs remain open. FULL durability and publication after commit remain the two approved intentional compatibility differences; the shared hotfixes do not add a planned product API delta.

### Local Git metadata reference parsing prerequisite

The internal, unwired `GitMetadataReference` helper parses already-supplied `.git` pointer and `commondir` bytes. It caps input at 16,384 bytes before UTF-8 replacement decoding, uses the existing ECMAScript trim set, preserves the exact pointer capture, keeps empty/independent `commondir` semantics and rejects raw network/device prefixes before any normalization. Its results remain untrusted reference text: drive/root-relative paths, NUL and other filesystem-invalid text are not admitted paths. It performs no filesystem access, Git/process execution, canonicalization, persistence or authority grant. Only its conformance tests call it; the twenty-five-method development surface and all deferred handler admission remain unchanged.

The reproducible Node oracle extracts the pointer/network expressions and metadata cap from the current TypeScript sources, records their SHA-256 identities and Node version, and verifies **698 committed vectors**. These cover every individual byte, malformed/truncated UTF-8 sequences, ECMAScript trim differences, BOMs, Unicode/spaces, exact captured text, pointer-versus-commondir grammar, mixed network/device prefixes and exact/over-limit byte inputs. The corpus is lexical evidence only; no Git, SQLite, provider, application data or network fixture is used by these new tests. Run `node tests/p2/git-metadata-oracle.mjs` to verify; explicit `--write` regenerates only the adjacent corpus, and only under Electron's Node (`node scripts/electron-node.mjs tests/p2/git-metadata-oracle.mjs --write`; see "Oracle runtime pin").

Local validation: Release build **zero warnings/errors**; **699/699** focused conformance tests; **6,800 native tests passed, zero failed, one expected local registry-policy skip (6,801 total)**; clean `pnpm check` with **542 tests across 75 files**; local package creation and package/expansion smoke **PASS**. Electron/TypeScript package proof remains separate from native helper conformance. Exact-source independent review is tracked in the sealed `test-results/p2-git-metadata-review` packet. The first Node check failed lint because the new oracle omitted an explicit `URL` import; that import was added, the failed log retained, and the final full check passed. Receipts: `test-results/p2-git-metadata-{oracle,build,focused,native-tests,pnpm-check,package,package-smoke}.log`. Renderer/IPC/user-path source did not change, so no new Electron E2E run was required.

This is a Git/files prerequisite, not complete repository inspection/admission or native Git handlers. Filesystem identity, alias/volume validation, pinned metadata and complete handlers remain future work. Electron/TypeScript remains shipping. Main integration, publication, adoption/real data, cutover/runtime selection, .NET enablement/native handler wiring, deployment, capture/installed S6, schema v6, live providers and protected approvals remain held. No push or new CI run is part of this increment.

### Successor ownership transfer

Recorded 16 October 2026. Ownership of the P2 port moved from Codex task `01a13d05` to a Claude Code session on branch `claude/foundry-p2-cutover-plan-11b4a7`. That branch was fast-forwarded to the retained parser commit `86827ae` (tree `94deb46`); no other source changed. The outgoing managed worktree was removed when its session was archived, and its ignored `test-results/` went with it.

**Lost evidence.** The parser seal, delivery receipt and raw logs cited above are lost, and so are the 14–15 October packets: baseline qualification, admission v2, native lease, PID diagnostics, stage markers and fixture launcher. They are not reconstructed.

**What survives.** The parser's independent SOURCE GO and the earlier independent reviews survive. The parser patch regenerates byte-exactly from Git.

**Where evidence lives now.** The surviving evidence, its hashes and the loss record are kept outside every worktree, in the owner's evidence store at `C:\Users\rdpro\Projects\foundry-evidence\transfer-86827ae\`. New increments write their evidence to sibling folders there. Publishing this stack still needs fresh validation bound to its candidate tree.

### P2 coverage for the Git/files slice

P2.0 is reconciled here only for the Git/files slice. The module map for later slices remains open.

**Method counts, enumerated from code at `86827ae`.**
- `RpcMethods` declares **89** methods. They are set-equal to the 89 RPC schemas among the 99 in `Contracts.json`. The migration plan's figure of 86 (in its summary and its P2 row) is historical.
- The development runtime's `DevelopmentChat.Dispatch` implements **25** of them. The other **64** reach its `NotSupportedException` default and execute nothing.

**Deferred methods that reach Git or files:**
- `project.add`, `task.create`, `workspace.upgrade`, and project-backed, coding or coordinated `task.start`.
- `files.list`, `files.read`, `task.diff`, `task.commit`, `task.push`, `task.retire` and `task.reconcilePublication`.
- The orchestration and continuity methods that create child or continued worktrees.

**Seam security tests that exist today.**
- TypeScript: `network-path`, `agent-channel` (alias coalescing; rebinding a junction, `commondir` or gitdir; legacy bindings), `projects`, `repository`, and `tests/p2/folder-admission.test.ts` (queued identity, final-boundary alias rebinding, unknown outcome after `worktree add`).
- C#: `RepositoryFolderTests`, the network vectors in `SecurityParityTests`, and the 698 `GitMetadataReferenceTests` vectors.

P2.1 below adds native identity coverage. The queued-identity, final-boundary and unknown-outcome workflows still need native worktree creation, which is P2.2.

**Reconciliation items, decided by Rudy on 19 October 2026:**
- **Local aliases: an approved difference to cutover.**
  - Native refuses every reparse point: junctions, symbolic links, and cloud-file placeholders such as OneDrive Files On-Demand. `RepositoryFolderLease` has done so since the native-lease increment, and P2.1's Git identity does too. It also refuses a `subst` spelling of a project folder (P2.2c).
  - TypeScript follows local junctions and symbolic links.
  - Rudy decided that native keeps refusing local aliases, permanently. A project whose folder, `.git`, gitdir or `commondir` passes through an alias is refused. This is no longer an open decision.
- **Drives: decided, and implemented natively (see "Removable project drives" below).**
  - Network and mapped network drives stay refused (decision 8). Native refuses them by drive type before any open; TypeScript refuses them only after realpath.
  - Removable drives are admitted for projects, as TypeScript admits them.
  - The data directory, the app-owned worktree base and its hooks folder, the executables the runtime launches and local-path push remotes stay on fixed drives.
  - The conflicting docs are resolved: the shared residuals entry above is corrected, and decision 8 stands.

### Local native Git identity foundation (P2.1)

**What it is.** `GitRepositoryLease` is internal and unwired. It is the native counterpart of `resolveGitAdmission`.
- Given a held `RepositoryFolderLease`, it walks up to the nearest `.git`.
- It reads the `.git` and `commondir` pointers through `GitMetadataReference` and resolves them as `path.win32.resolve` does.
- It returns the canonical `{path, root, gitDirectory, common}` identity, with a serialization key equal to `common.toLowerCase()`.

**Differences from TypeScript, all of which fail closed:**
- **No redirected probe.**
  - **Chain first.** For the folder's canonical path and for each referenced directory, the parent chain is opened one component at a time without following reparse points (`DirectoryLease`). Only then is the final component probed, pinned and canonicalized with `FinalPath`. When a subst or 8.3 spelling is used, the canonical chain is verified and pinned as well.
  - **Exact names.** Every component and metadata open uses its `\\?\` namespaced name, so Win32 cannot strip a trailing space or dot and verify a different entry than the one traversal later reaches. Referenced paths with a component ending in a dot or space are refused outright.
  - **Drives.** Mapped network drives are refused by drive type before any open. Since 19 October 2026 removable drives are admitted for projects, and every other type that is not fixed is refused (see "Removable project drives").
  - The shared local-reparse residual for project listing is unchanged.
- **Bounded pointer reads.** Pointer files are pinned with read-only sharing and read through the handle up to 16,385 bytes; a 16,385th byte rejects the file. TypeScript stats the file and then reads all of it, so growth after the stat is read without bound. Shipping TypeScript is unchanged, because this is neither a security nor a data-loss fix.
- **Pins that let Git work.** Directory pins share writes but never deletes. Git's lock-file renames inside a pinned directory keep working, while the pinned directories themselves cannot be renamed, deleted or replaced until disposal. Pins defend against races, not against a hostile process running as the same user, which could still empty a pinned directory and turn it into a mount point.
- **Strict revalidation.** Revalidation resolves again and requires ordinal equality with both the lease and the expected binding. A null or incomplete binding never matches.
- **Approved differences, named in the corpus:**
  - Local aliases are refused (an approved difference, decided by Rudy on 19 October 2026).
  - A drive-relative pointer to another drive is refused, because TypeScript resolves it from per-drive process state.
  - A `commondir` that names a file is refused, where TypeScript accepts the file as the "common directory".
- **Ambiguous references are refused before the lease opens them.** These are references that Win32 would read as another entry: a component ending in a dot or space, a stream suffix, or a reserved device name. TypeScript also fails them, but later and with raw filesystem errors. A real directory whose name ends in a dot or space is refused too, which is stricter than TypeScript.

**Supporting changes.**
- `DirectoryLease` gained a write-sharing variant and a typed `ReparsePointException`, which keeps the existing message.
- `DirectoryLease` now opens each component by its namespaced name. This also affects data-directory and folder admission:
  - an intermediate name ending in a space or dot is taken literally, so a junction with such a name is refused rather than verified through a decoy (the same exposure existed in `RepositoryFolderLease`);
  - paths longer than `MAX_PATH` now work instead of failing closed.

  `PinDatabase` still opens its file by its Win32 path.
- `MetadataFile`, `PinnedMetadataFile` and `PathReference` are new Platform primitives.
- Nothing in Store, DevelopmentChat, Program or the protocol calls any of this. The 25-method surface, handler admission and selectors are unchanged.

**Evidence.**
- `tests/p2/git-identity.test.ts` builds **43** disposable trees: hand-built pointers, junctions, and a real `git worktree add`. It pins the shipping resolver's outcomes in `git-identity-vectors.json`, bound to the SHA-256 of `repository.ts` and `network-path.ts`. Regenerating the vectors requires `P2_WRITE_GIT_IDENTITY=1`.
- `GitRepositoryLeaseTests` rebuilds every tree and must match each outcome or its named difference. Where Node raised a raw `ENOENT` or `EISDIR`, native must refuse. The class adds tests for:
  - pins and Git lock-file renames;
  - revalidation;
  - release of partial pins after a failure;
  - loop affinity;
  - folders with no repository;
  - the serialization key;
  - decoy-plus-junction regressions for names ending in a space or `..`, covering the folder lease, the gitdir and the `commondir`;
  - exact refusal messages for each screened name form;
  - paths longer than `MAX_PATH`.
- `MetadataFileTests` covers:
  - probe kinds;
  - exact-limit and over-limit reads, up to 64 MiB;
  - pin refusal of append, rename and delete;
  - a fail-closed open while a writer holds the file;
  - refusal of directories and junctions;
  - refusal of anything that is not a drive-absolute path, before any open;
  - paths longer than `MAX_PATH`;
  - reference resolution checked against Node.

  The file-symbolic-link case skips when Developer Mode is off.

**Independent review.** A read-only filesystem/security reviewer (Opus, high effort, below the xhigh owner) reviewed the first committed tree, `a9c88b6`. It returned **NO-GO** on one confirmed medium finding:
- `GetFullPath` keeps an intermediate component ending in a space or `..`.
- `DirectoryLease` opened that component without a namespace, so Win32 stripped the suffix. Verification therefore checked a plain decoy directory while traversal went through an unverified junction with the exact name.
- The reviewer reproduced this with a decoy and a junction named `a `.
- The same root cause also reached `RepositoryFolderLease`.

The reviewer also raised:
- **Low:** the case count was overstated (44 instead of 43), and two claims overreached.
- **Low:** paths longer than `MAX_PATH` failed without being listed as a difference.
- **Informational:** an unpinned subst chain.
- **Informational:** a test assertion that was too weak.

Each finding is fixed in the follow-up commit, with regression tests.

Re-review of `bbf5360` returned **GO** with one low, non-blocking finding. `GetFullPath` still stripped a trailing dot or space from the *last* component, so `DirectoryLease` pinned a decoy for a name such as `a `. Inside the Git lease this could not cause an unverified traversal, but the fix is cheap: `DirectoryLease` now refuses a final component ending in a dot or space and still normalizes `.` and `..`. A final-component decoy test covers it. The reviewer's confirmation of that delta is recorded with the evidence.

**Local validation of the final tree.**
- Release build: **zero warnings or errors**.
- Focused conformance: **792/792**. This adds the Store and Upgrade classes, which use `DirectoryLease`.
- Focused platform: **30/31**; the file-symbolic-link case skipped.
- Full native suite: **6,890 passed, zero failed, two skipped (6,892 total)**. The skips are the expected local registry-policy test and the file-symbolic-link test.
- `pnpm check`: clean, **543 tests across 76 files**.
- Local package creation and package/expansion smoke: **PASS**. This is Electron/TypeScript proof only.
- `git diff --check`: clean.

**Failures that are retained.**
- The first full run failed two existing assertions that expected exactly `IOException` for a junction refusal. They now assert the typed `ReparsePointException`.
- One final-tree `pnpm check` timed out in the unchanged `git-operations.test.ts` cherry-pick case after 20 seconds and then reported `EBUSY` during cleanup. That file took 243 seconds in the run. Run alone, it passed **27/27**, and the repeated full check passed.

Both failed logs are retained. The final-component guard changed only native source, tests and this document. Its native checks reran in `run4`; the `run3` `pnpm check` and package proof still applies to the unchanged TypeScript and Electron sources. All logs are in `foundry-evidence\p2.1-git-identity\run1` through `run4`. No renderer, IPC or user-path source changed, so no Electron E2E run was required.

**Residuals.** These belong to P2.2:
- the per-common-repository serialization queue;
- revalidation at handler time;
- the read-only sharing of `RepositoryFolderLease`, which blocks renames into the project folder while it is held.

Tests do not exercise mapped-drive or subst behavior, because no network share or session drive letter is touched. P2 remains incomplete, and every hold listed above is unchanged.

### P2.2 Git/files handlers and project/task admission — authority and slices

Recorded 16 October 2026. Rudy wrote: "Start P2.2 in a fresh session and I authorize wiring the completed Git/files handlers into the development-only DevelopmentChat surface (FOUNDRY_RUNTIME_P2_CHAT gate only, no shipping selector); keep native alias refusal for now." He then approved this slice order:
- **a:** an unwired foundation: Git execution, read-only inspection, the per-repository queue and intents;
- **b:** `files.list`, `files.read` and `task.diff`;
- **c:** `project.add`;
- **d:** `task.create`, with worktree creation;
- **e:** `task.commit`, `task.push`, `task.reconcilePublication` and `task.retire`;
- **f:** project-backed `task.start` for folders that are not Git repositories;
- **g:** an unwired one-shot primitive for editing existing files.

**Left out of P2.2:**
- `workspace.upgrade`.
- Git-project `task.start`, and `task.send` on Git tasks. Every Git task's first turn advertises project-channel tools, and coding adds tools that need approvals and the native tool loop.
- Coordinated mode.

Everything else stays held: shipping or runtime selectors, Electron-side .NET enablement, push, PR, CI, main integration, schema v6, adoption, real data, live providers and cutover.

**Publication.** Rudy approved pushing the branch and opening a draft pull request for exactly `6f5530a..e7c8460`, with no merge. That draft is #36. To fix its failed checks, `main` at `11d7208` (#33 and #34) was merged into the branch.
- #33 changed `repository.ts`. Seven P2.2 vector files bind that file's SHA-256, and both the Node oracles and the native `AssertOracleSources` failed on that hash alone.
- The seven files were regenerated from the shipping runtime. Each one changed only that hash: #33 moved no recorded P2.2 outcome.
- **Slice c's root-relative case depended on the machine.** The next run showed it: a root-relative path names the scratch folder only when the working directory and the temporary folder share a drive, and the CI runner keeps its workspace on D: and TEMP on C:. Both runtimes refused there, so neither matched the recorded result.
  - The case is now marked `sameDrive`. Where the drives match, it is fully pinned and replayed as before.
  - Where they differ, the Node oracle keeps the committed entry and the C# case is skipped with that reason. On CI the root-relative case is therefore not exercised.

### Local Git execution and inspection foundation (P2.2a)

**What it is.** These internal classes are unwired. Nothing in `DevelopmentChat`, `Program` or the protocol calls them, so the 25-method surface is unchanged.
- `GitRunner` is the counterpart of `RepositoryService.git` and `gitEnvironment`.
- `RepositoryService` is the counterpart of the read-only half of `repository.ts`: `requireRoot`, `requireRepository`, `isGitWorkingTree`, `listFiles`, `readFile`, `uncommittedPaths`, `diff`, and the three filter refusals.
- `RepositoryAdmission`, the per-common-repository queue, and the Store intent primitives.

**Git execution.**
- **Launching.** Git runs only through `JobProcess`. The executable is the first `git.exe` in an absolute `PATH` entry that is a regular file outside the repository first asked about. The choice, or the failure, is remembered for the life of the service, as in TypeScript.
- **Environment and configuration.** Every variable whose JavaScript upper-case name starts with `GIT_` is dropped; this includes the dotless `ı`, which .NET's invariant casing would keep. `GIT_CONFIG_NOSYSTEM` and `GIT_TERMINAL_PROMPT` are pinned. Hooks point at the empty hooks directory, which every launch now requires to be empty (review H1 under P2.2e), fsmonitor is off, and credential helpers are off unless allowed.
- **Limits and errors.** The timeout is 15 seconds and the output cap 256 KiB. Error mapping, including which messages gain the `Git command failed:` prefix, follows `repository.ts`.

**Revalidation, pins and queue (residuals 1–3 of P2.1).**
- **Revalidation.** The admitted identity is checked again before launch, at the final boundary (`BeforeMutation`), and after exit. A folder with no repository must still have none.
- **Pins.** A `RepositoryAdmission` holds the folder lease and the Git lease across every await of an operation. `RepositoryFolderLease` now shares writes but never deletes: renames into the folder work, and the folder chain itself cannot be renamed or deleted while held.
- **Queue.** Callers key the queue on the identity's `common.toLowerCase()`. Operations with one key run in arrival order, a failure never blocks its successor, and the key is released when its last operation settles. As TypeScript's `.then` defers, an operation starts only after its key is registered.
- **Outcomes.** Git failures (`GitCommandException`) and plain refusals never claim an outcome. Only a caller that knows where its final mutation boundary was classifies one (`RepositoryException`, TypeScript's `RepositoryError`), as `createTaskWorktree` does with the flag its final-boundary callback sets.

**File access at the execution boundary.**
- The parent chain is pinned and verified free of reparse points (`DirectoryLease`).
- The final entry is opened by its exact namespaced name without following a reparse point (the new Platform `ExistingEntry`).
- Containment and sensitive-name checks run on the handle's real path. Reads go through that handle, bounded at 64 KiB plus one byte, where TypeScript stats the file and then reads it unbounded.
- Name rules reproduce JavaScript regular expressions: ASCII-only case folding (a Kelvin sign never matches `k`), `.` excluding U+2028/U+2029, and `$` meaning end of input.
- Listings sort with the `en-US` collation, stably.

**Differences from TypeScript, all of which fail closed or are invisible on success:**
- Local aliases are refused (the approved difference).
- Every reparse point is refused as "Symbolic links cannot be accessed.", including cloud placeholders, which Node follows.
- Node's raw filesystem errors (`ENOENT`, `ENOTDIR`) become fixed native messages.
- `PATH` entries that are network or device paths, or that are not on a fixed local drive, are skipped before any probe. As in TypeScript, a link inside a local entry is still followed.
- A timeout or an output overflow terminates the whole job tree; Node signals only the root process.
- Standard input is closed at launch.
- Revalidation also runs after a non-zero exit.
- A NUL argument gets a fixed message.
- A root or folder segment ending in a dot or space is refused by name. `GetFullPath` would otherwise strip the ending and admit the sibling, while Node opens the literal name; a real folder with such a name is refused too, as P2.1 refuses those names in Git references.
- Filters at a revision accept only a full object id; every TypeScript caller passes the id `rev-parse` returned.
- Truncated output is the first 256 KiB of bytes, where Node's cut point can depend on pipe chunking for multi-byte text.

**Evidence.**
- `tests/p2/repository-inspection.test.ts` builds **87** disposable trees with an isolated `HOME`, no system Git configuration and the C locale. It pins the shipping outcomes in `repository-inspection-vectors.json`, bound to the SHA-256 of `repository.ts`, `git-environment.ts` and `network-path.ts`. The cases cover listings, reads, status, diffs, classification, `core.worktree`, bare and unborn repositories, linked worktrees, and filters at the working tree and at a revision. The file also pins `gitEnvironment()`'s handling of edge variable names. Regenerating the vectors requires `P2_WRITE_REPOSITORY_INSPECTION=1`.
- `RepositoryInspectionTests` rebuilds every tree and must match each outcome or its named difference. Mutating two expected outcomes made both cases fail.
- `GitRunnerTests` covers:
  - injected `GIT_*` variables that try to redirect the repository;
  - executable selection;
  - a timeout that must kill a grandchild holding the pipes;
  - overflow and non-zero exits, with and without permission;
  - identity changes before launch, at the final boundary and after exit;
  - queue ordering and failure isolation;
  - intent bytes and states;
  - quoting round-tripped through `CommandLineToArgvW`;
  - loop affinity;
  - `ExistingEntry`.
- `RepositoryFolderTests` now proves renames into a held folder.

**Independent review.** A read-only filesystem/security reviewer (`cloud-security-vulnerability-expert`, Opus at high effort below the xhigh owner, chosen for the security and data-integrity verdict) reviewed the sealed commit `c44b469`. Its verdict was **GO with conditions**. It verified the seal, built an archive export and probed each finding.
- **M1 (medium).** The runner reported every failure after launch as "no mutation started". A probe ran an alias that updated a ref and then outlived its timeout; the ref landed. Fixed: the runner and plain refusals carry no outcome, and a test proves that a mutating command that times out is not reported as "none".
- **M2 (medium).** `GetFullPath` stripped a trailing dot or space from a root segment, so native listed `repo` for `repo.`, `repo ` and `repo...`, which Node reports as missing. Fixed by the name screen above, with four new vectors.
- **L1 (low).** Classifying a file root threw where TypeScript returns false. Fixed, with two vectors; the catch now covers every failure TypeScript's catch-all would.
- **L2 (low).** An operation with no predecessor started before its queue key was registered. Fixed, with a test.
- **L3 (low).** The documentation overstated how far the `PATH` lookup avoids the network. Fixed by the drive-type check and the corrected wording above.
- **L4 (low).** The runner took a working directory separate from the admitted folder. It now always runs in the admitted folder.
- **Informational.** Applied: unreadable untracked files are skipped as TypeScript skips them; Git's reported top-level path is opened only on a fixed local drive (fixed or removable since 19 October 2026); revisions must be full object ids. Not changed: a running Git process is not cancelled by shutdown and ends within its timeout, as TypeScript's drain waits; `ExistingEntry.Links` stays unused, because hard-linked reads match TypeScript.

### Read-only Git/files handlers (P2.2b)

**What it is.** With `FOUNDRY_RUNTIME_P2_CHAT=1`, the development runtime now serves `files.list`, `files.read` and `task.diff`. That brings it to **28** of the 89 methods. No other surface, selector or schema changed.
- **Task roots.** They follow `service.ts`:
  - a Git task (including a legacy task with no workspace kind) uses its worktree;
  - a folder task uses its saved folder only while that folder still resolves to the same physical folder under the exact spelling it was saved with;
  - any other task has no folder access.
- **Redaction.** `files.read` content and the diff's patch and summary are redacted. Refusals reach the caller as TypeScript's entry reports them: the message, redacted.
- **Worktree base.** It is the data directory's `wt` folder, as `entry.ts` places it.

**Approved-path comparison.** For a folder task, the saved spelling is both the candidate and the approved path, and the folder lease refuses every reparse point. Native therefore keeps only the check that the real path still has the saved spelling, case-insensitively. Before #33, TypeScript refused a short (8.3) spelling one check earlier, with the shorter "different location" message. Since #33, its `resolveLocalPath` admits an 8.3 spelling of the same folder, so both runtimes refuse it at this same check with the same message. The native comparisons that slice c adds compare file identity, never lowercased keys.

**Differences:**
- Local aliases are refused (the approved difference).
- Node's raw filesystem errors become fixed messages.

**Evidence.**
- `tests/p2/repository-handlers.test.ts` drives the shipping `RuntimeService` over seeded folder, Git, legacy, projectless and missing tasks, including:
  - network and moved roots;
  - spelling variants;
  - junctions;
  - redaction;
  - refusals.

  It pins the outcomes of 41 calls across 14 cases in `repository-handler-vectors.json`, bound to the SHA-256 of `service.ts`, `repository.ts`, `redaction.ts` and `store.ts`. It also asserts that no persisted row changes. Regenerating the vectors requires `P2_WRITE_REPOSITORY_HANDLERS=1`.
- `RepositoryHandlerTests` seeds the same tasks into a fresh native Store and dispatches through `DevelopmentChat`. It must match each outcome or its named difference, and leave every row unchanged. Mutating a redacted result and an error made both cases fail.
- `DevelopmentChatProcessTests` drives the three methods through the stdio entry point: listing, redacted content, refusals, a redacted diff, and no notifications.
- The two oracles share `tests/p2/repository-fixture.ts`. Slice a's inspection vectors are unchanged.

**Independent review.** The same reviewer re-reviewed the P2.2a fixes and slice b at `ddfa750`. It confirmed M1, M2 and L1–L4 fixed, then returned **NO-GO** on one new confirmed medium. Its stdio probe against the built runtime found the defect.
- **N1 (medium).** A NUL in a renderer-supplied `files.read` or `files.list` path made `GetFullPath` throw an unmapped `ArgumentException`, which stopped the development runtime. TypeScript answers with a redacted error and keeps serving.
- **N1b (low).** A NUL in the final segment read the truncated name, so `notes.txt\0zzz` returned `notes.txt`. Deny-listed names stayed refused, because the real-path check caught them.

Fixed in the follow-up commit:
- Relative paths with NUL are refused as forbidden segments.
- The folder lease and `SameFolder` refuse NUL before any path call, and `MetadataFile.Namespaced` refuses it before any open.
- Every argument, filesystem or access failure in a Git/files handler now becomes the redacted refusal.

The reviewer's informational notes were also applied:
- A folder task's lease stays held across the list or read it checked (N2).
- The folder lease screens the real path for dot and space endings as well as the spelling (N3).
- Like TypeScript, listings and reads stay synchronous with no entry limit, and a stuck Git process holds shutdown until its timeout (N4); the reply size limit still applies.

New coverage:
- vectors for NUL in middle and final segments, in `files.list`, `files.read` and `project.add`; Node refuses each with `ERR_INVALID_ARG_VALUE`;
- an `ExistingEntry` NUL test;
- a stdio test that the runtime answers every NUL request with a refusal and then serves a valid read.

### Project admission (P2.2c)

**What it is.** The development runtime now serves `project.add`, bringing it to **29** of the 89 methods. The handler follows `service.ts`:
1. **Refusals before any probe.** Saved projects require schema v3 or newer. A relative path is refused, and so is a network or device path, before anything is opened.
2. **Pin and classify.** The folder is pinned from its first resolution until the row is saved. A folder that is already saved returns its project without a notification. Classification runs `isGitWorkingTree` under the pin.
3. **Final checks.** The requested spelling must still name the pinned folder, and the Git identity read before classification must be unchanged.
4. **Save.** Only then is the project inserted, or found again if a concurrent request saved it first. The `projects.changed` event commits in the same transaction.

**Approved-path comparison by identity.** TypeScript's recheck, `resolveLocalPath(raw, path)`, becomes `RepositoryPaths.SameFolder`. It follows the reviewed guidance from the TypeScript 8.3 fix:
- Both chains are pinned without following a reparse point, and a reparse point in either refuses.
- The drive type is checked before the approved spelling is probed.
- The spellings match only when they have the same root, the same depth, and the same volume serial number and 128-bit file identifier (`FileIdInfo`) at every prefix. The new `DirectoryLease.Identities` provides these.
- So a different case or a short (8.3) spelling of one folder matches. Two folders that differ only in case inside a case-sensitive directory never do; a lowercased key would have matched them.
- A segment ending in a dot or space is refused, as the folder lease refuses it.

**Differences:**
- Local aliases are refused (the approved difference).
- Node's raw filesystem errors become fixed messages.
- **Atomic notification.** The project row and its notification commit together, and the notification is published after the commit. TypeScript inserts the project and then records the event separately, so a failed event insert leaves a project with no notification. That gap is pre-existing in TypeScript and is not changed here.

**Evidence.**
- `tests/p2/project-admission.test.ts` adds folders through the shipping `RuntimeService`:
  - every spelling of one repository;
  - subfolders, plain folders, linked worktrees and nested repositories;
  - a repository that configures `core.worktree`;
  - root-relative, relative, network and device paths;
  - files, missing folders, broken Git pointers and a junction;
  - two concurrent additions of one folder.

  It pins the returned projects, refusals, saved rows (path keys included) and events in `project-admission-vectors.json`, with generated identities and stamps normalized in order of appearance. It is bound to the SHA-256 of `service.ts`, `repository.ts`, `store.ts` and `network-path.ts`. Regenerating the vectors requires `P2_WRITE_PROJECT_ADMISSION=1`.
- `ProjectAdmissionTests` replays every case through `DevelopmentChat`. It must match each outcome or its named difference, and every committed notification must be published after its commit, in order. The class also covers:
  - folder identity: case, separators, `..`, aliases in either chain, missing folders, and network and device spellings;
  - two tests that report a skip when the machine cannot exercise them: a short (8.3) spelling, where the volume generates short names, and case-sensitive directories, where `fsutil` can enable them. Both ran on the development machine;
  - prefix identities from the drive root;
  - a common directory redirected while classification runs Git, which must save nothing and notify nothing.

**More differences, both fail-closed:**
- A `subst` drive spelling of a folder is refused. Its chain has a different root and depth from the real path, while TypeScript's lowercased comparison admits it. This sits with the approved alias refusal (Rudy, 19 October 2026).
- On a volume that cannot report `FileIdInfo` (FAT or exFAT), the identity check fails and the project is refused. Since 19 October 2026 this reaches removable drives too, which are often formatted FAT32 or exFAT (see "Removable project drives").

**Independent review.** The same reviewer reviewed the N1 fix and slice c at `586e929` and returned **GO for P2.2a, P2.2b and P2.2c together**. It ran the focused suites (149 passed) and the stdio NUL test on its own export. It probed `project.add` through `DevelopmentChat` with an 8.3 spelling, a case variant, and the short name of a real `dotted.` folder, with and without a child path.

Its remaining notes:
- **C1 and C3.** The two differences above, now documented.
- **C2.** The optional identity branches now report a skip instead of passing silently.
- **C4.** Every argument failure in a Git/files handler becomes a refusal, as TypeScript's entry handles every handler error. The cost is that a programming error there shows as a refusal, not a runtime failure.

### Git-backed task creation (P2.2d)

**What it is.** The development runtime now serves `task.create`, bringing it to **30** of the 89 methods. It creates a chat or coding task with its own app-owned worktree, following `service.ts`, `RepositoryService.createTaskWorktree` and `agent-channel.ts`:
1. **Refusals before any intent.** These come first, in TypeScript's order:
   - network and device paths, missing paths and aliases;
   - profiles;
   - coordination settings on a chat task;
   - the coding-profile probe;
   - an earlier unknown creation;
   - a folder that is not a repository.
2. **Durable intent.** The `worktree.create` intent is written next, before any Git mutation.
3. **Serialized creation.** The worktree is created under the per-common-repository queue. The caller's admitted identity is revalidated across every await, at the final boundary before `git worktree add --no-checkout`, and before `checkout --no-recurse-submodules`. Filters are refused at the base revision, and the worktree base `<data>\wt` is pinned free of reparse points while the worktree is added.
4. **One commit.** The project (upserted, and promoted from folder to Git), the task, the channel identity binding, the completed intent and the `tasks.changed` notification commit together.

**Outcomes.** A failure before the final boundary leaves the intent complete. Any failure after it leaves the intent unknown, saves no task, and refuses every later creation until someone inspects the retained worktree. Restart recovery turns an interrupted (pending) intent into unknown. Nothing retries.

**Differences:**
- Local aliases are refused (the approved difference).
- Coordinated tasks need the orchestrator, a later slice, so native refuses them before any intent with TypeScript's "not available in this build" message.
- A project path that names a file is refused before any intent. TypeScript refuses it inside worktree creation and leaves a complete intent row.
- Node's raw filesystem errors become fixed messages.
- **Atomic project upsert.** The project upsert commits with the task. TypeScript saves it before the task's transaction.

**Evidence.**
- `tests/p2/task-creation.test.ts` drives the shipping `RuntimeService` through 19 cases:
  - chat and coding tasks;
  - repeated, concurrent, subfolder and linked-worktree creation;
  - a folder project that later becomes a repository;
  - redaction, external profiles with and without a probe, and coordination settings;
  - unknown profiles;
  - non-repositories, and missing, relative, network and NUL paths;
  - unborn repositories, base-revision filters and `core.worktree`;
  - an earlier unknown creation;
  - a junction and a coordinated task.

  It pins every outcome in `task-creation-vectors.json`, bound to the SHA-256 of `service.ts`, `repository.ts`, `agent-channel.ts`, `store.ts` and `git-environment.ts`. The pinned state covers every task, intent, project and event row, plus the repository's refs, worktrees, and each new checkout's status and files. Generated identities and stamps are normalized in order of appearance, and refs and worktrees are ordered by placeholder. Regenerating the vectors requires `P2_WRITE_TASK_CREATION=1`.
- `TaskCreationTests` replays every case through `DevelopmentChat`. Where a difference is named, it requires the refusal and unchanged rows and repository. It also ports `folder-admission.test.ts`'s three workflows to native form:
  - queued requests whose identity changes while the first waits (via a redirected common directory, since aliases are refused) both fail before mutation;
  - an identity change at the final boundary is a known pre-mutation failure;
  - a failure after `worktree add` keeps the branch and worktree, marks the intent unknown, blocks later creation and stays unknown across a restart.

  A pending intent recovered on restart blocks creation too.
- `DevelopmentChatProcessTests` drives `project.add`, `task.create` (with protocol defaults and trimming applied by the entry point), `files.list` and `task.diff` through stdio, with their notifications.

### Git publication and retirement (P2.2e)

**What it is.** The development runtime now serves `task.commit`, `task.push`, `task.reconcilePublication` and `task.retire`, bringing it to **34** of the 89 methods. These are the user's explicit Git actions from `workspace-operations.ts`; no model proposes or executes them.
- **Commit.** Only a ready, non-coordinated chat or coding task with no unknown approval, publication or retirement outcome can commit, and one Git action runs per task at a time. The commit message must survive redaction unchanged. The `git.commit` intent records the base commit before anything is staged. Secret-named paths are refused, and filters are rechecked before `git add`. Hooks stay disabled, signing is off, and the identity comes from the user's Git configuration.
- **Push.** It never forces or prompts, and only a remote configured in the project repository is accepted. The user's credential helper may run here and for the remote check of an unknown push, and nowhere else.
- **Reconcile.** It checks unknown pushes against the remote and unknown commits against the worktree; an unresolvable one stays unknown. It completes an unknown retirement when no listed worktree remains, and marks it failed otherwise.
- **Retire.** It removes only an app-owned worktree that Git proves clean (`git worktree remove`, no force), keeps the branch, and marks the task retired.
- **Outcomes.** Refusals before staging, pushing or removal are "none". A failure after that point, or one whose effect cannot be established, is "unknown". It blocks the task's later Git actions until reconciled, and nothing retries.
- **Commit together.** The completed intent, the task change and the notification commit together.
- **Notifications.** `task.committed`, `task.pushed` and `task.retired` are sent. As in TypeScript, the status transition that retirement records stays silent.

**Differences, all fail-closed or invisible on success:**
- Coordinated tasks retire their children with them, which needs the orchestrator, so native refuses them.
- A worktree saved on a network path is refused, and is never probed during retirement or reconciliation.
- A successful commit, push or retirement commits its completed intent, task change and notification together; TypeScript saves them separately.
- A commit, push or reconciliation in flight and a retirement of the same task exclude each other (review L1 below).

**Evidence.**
- `tests/p2/task-publication.test.ts` drives the shipping `RuntimeService` through seven cases, using a local bare remote only:
  - a full commit, push, reconcile and retire;
  - every refusal before staging;
  - a commit that fails after staging (unknown, then reconciled as failed);
  - a push to a missing remote (unknown, unresolvable until the remote exists, then reconciled);
  - a dirty retirement;
  - concurrent Git actions on one task;
  - missing tasks.

  It pins results, refusals, task, intent and event rows, refs, worktrees, remote refs, and the worktree's status and recent log in `task-publication-vectors.json`. Generated identities, commit object ids and stamps are normalized in order of appearance. It is bound to the SHA-256 of `workspace-operations.ts`, `repository.ts`, `service.ts`, `store.ts` and `git-environment.ts`. Regenerating the vectors requires `P2_WRITE_TASK_PUBLICATION=1`.
- `TaskPublicationTests` replays every case through `DevelopmentChat`. It also proves:
  - retirement failures are classified by whether the worktree remains, and an unknown retirement is reconciled;
  - only push and remote verification run without `credential.helper=`;
  - an unknown approval blocks publication and retirement.
- `DevelopmentChatProcessTests` now drives commit, push and retire through stdio with their notifications.

**Independent review of P2.2d and P2.2e.** The same reviewer reviewed the sealed ranges `586e929..9208cf9` and `9208cf9..f199fd1` (with `0e67144`) and returned **GO for both as a port**. It verified both seals, built an export, and matched every mutation boundary's outcome classification against TypeScript: intent before mutation, no blind retry, and creation serialized per common repository. It ran one probe through `DevelopmentChat`.
- **H1 (medium, confirmed, also in shipping TypeScript).** "Hooks stay disabled" held only while `<data>\wt\.empty-git-hooks` was empty. `--no-verify` does not cover `post-commit`, `post-checkout` or `reference-transaction`. The reviewer planted a `post-commit` hook there and it ran during `task.commit`. Anything that writes the app data folder once would gain execution in every later app-initiated checkout and commit, in every repository.
  - **Fixed natively** for every Git launch (`GitRunner.Run`), with the same semantics and messages as the TypeScript fix (`assertNoGitHooks` on `claude/fix-empty-git-hooks`):
    - **Before launch.** After identity revalidation and before the final-boundary callback, the folder must be missing, or a directory with no entries. Native also pins its whole chain free of reparse points until exit. Otherwise the refusal is "Git command failed: The app-owned Git hooks folder is not empty; refusing to run Git. Inspect and empty <hooks folder> to continue."
    - **After exit.** Once Git has started, the folder is checked again however the run ended: it must still be missing, or still a directory (not a link) with no entries. Otherwise the call fails with "The app-owned Git hooks folder changed while Git ran; a hook may have run. Inspect and empty <hooks folder>.", without the prefix and superseding whatever Git reported, as TypeScript's `finally` does.
  - A directory handle cannot forbid new entries (probed: a read-only-shared directory handle blocks renames into the folder, not creation), and a pin that shares writes cannot forbid attribute changes. So a same-user process can still add an entry, or turn the folder into a link in place, during a run. The check after exit then fails that run, and the next launch refuses before starting. A hook that removes itself before Git exits is not detected, in either runtime.
  - A refusal before launch is a Git failure with no outcome. Callers classify it as before: `task.create` leaves its intent complete, and a commit refused at `git add` stays unknown until reconciled. A failure after exit is a failure after launch, so a caller past its final boundary classifies it unknown.
  - Native has one Git launch site, and it never passes an empty `core.hooksPath`. Git resolves an empty one to the drive root, which the TypeScript review found for the pre-approval command runner; that runner is not ported yet.
  - Tests:
    - `GitRunnerTests` covers a planted hook (with a control proving it live), a subfolder, a junction, a file in the folder's place, and hooks or a file appearing during a run, including one whose Git failure the change supersedes.
    - `TaskPublicationTests` shows commit and creation refusing with no Git launch and no hook execution, then working once the folder is empty.
    - Disabling the guard made both fail. Disabling the check after exit made the runner test fail.
  - **TypeScript half: landed separately (#35).** AGENTS.md requires security and data-loss fixes to land in both runtimes. `repository.ts` (`prepareWorktreeBase` and `git()`) and `git-operations.ts` (`hooksDirectory()` and its Git calls) had created and used the same folder with no emptiness check since the foundation commit.
    - This branch stayed native-only, so the TypeScript fix was not delayed behind the P2.2 stack.
    - The TypeScript fix is #35 (`claude/fix-empty-git-hooks`). It also stops the pre-approval `command-runner` Git from using an empty `core.hooksPath`, which Git resolves to the drive root. See the H1 dual-landed entry.
    - When #35 merged main, the P2 vectors were re-pinned, and their TypeScript refusal messages were confirmed to match the native ones above.
- **L1 (low, parity).** Retirement could remove a worktree while that task's commit was at its final `rev-parse`, leaving an outcome nothing could verify. **Fixed natively**: retirement refuses while a commit, push or reconciliation of the task is in flight, and commit and push refuse while it retires, with TypeScript's existing messages. Tested in `TaskPublicationTests`.
- **L2 (informational, parity), not changed.** `RemoveWorktree` resolves its target through links after the lease that refused a reparse worktree is released. Exploiting the gap needs same-user write access.
- **L3 (informational, parity), not changed.** Reconciliation counts a retired worktree that cannot be probed as gone, as TypeScript's `stat` catch does. Nothing is deleted on that basis; the worktree and branch stay on disk.
- **L4 (informational).** The atomic success commit is now named in the differences above.

**Codex review of #36.** The repository's Codex reviewer left five findings on the publication code. Every one also held for the shipping TypeScript (`repository.ts` `uncommittedPaths`, `push`, `verifyPushOutcome`, and `workspace-operations.ts`). TypeScript now has the four native fixes below. It also has the push allowlist and remote checks that #37 added natively. Both are recorded under "Publication hardening" in the dual-landed fixes. Four are fixed natively as fail-closed differences:
- **Staged rename of a secret-named path (P1).** Porcelain v1 writes a staged rename's source after its destination, and the source was skipped. The staged listing also detects renames, so `git mv .env safe.txt` showed only `safe.txt`, and the commit would publish the secret file's content under the safe name.
  - **Fixed natively:** `CommitAll` screens both endpoints of every rename or copy before staging, and screens the staged paths again without rename detection.
  - `UncommittedPaths`, and the diff and retirement checks that use it, keep TypeScript's output.
- **Worktree no longer the task's repository (P1).** Commit and push never checked that the worktree still belongs to the task's project. A folder replaced by another repository on the saved branch would be committed to, and pushed with that repository's own remotes.
  - **Fixed natively:** before staging or pushing, the worktree must share the project repository's common directory. When the task has a `channel.identity` binding, that common directory must also be the bound one.
  - The held worktree admission keeps that identity pinned for the rest of the operation. A refusal is "none".
- **Push URL during reconciliation (P2).** `ls-remote` reads the remote's fetch URLs, while push writes to its push URLs. **Fixed natively:** when the two lists differ, the push stays unknown instead of being judged against another server. Querying the push URL directly would pass a configured URL to Git where it could act as an option.
- **SHA-256 remote tips (P2).** The remote-tip pattern accepted only 40-character object names. In a SHA-256 repository, every ambiguous push therefore stayed unknown for good. **Fixed natively:** 64-character names are accepted too.
- **Repository-local configuration on push (P1).** Push and remote verification enable credential helpers, and a helper set in the repository's own configuration (for example `credential.helper = !command`) runs as a shell command.
  - Removing only the helper would be a partial fix. A push also honors other repository settings that run programs: `core.sshCommand`, remote transport programs, `ext::` URLs once allowed, and URL rewrites.
  - **Fixed natively after P2.2, with the allowlist the independent review recommended.** Rudy chose it on 17 October 2026.
    - Before a push or a remote check, `RequireTrustedPushConfiguration` lists the effective configuration with its scopes (`git config --list --show-scope -z`).
    - Every key from the repository's own scopes must be on the allowlist; included files appear under their including scope. Anything else refuses with "none": "Push refused: the repository's own Git configuration sets `<key>`, which push does not trust. Move it to your global Git configuration or remove it." The key is shown without its subsection, which can hold a URL with credentials.
    - The allowlist:
      - `core.` `repositoryformatversion`, `filemode`, `bare`, `logallrefupdates`, `symlinks`, `ignorecase`, `autocrlf`, `eol`, `safecrlf`, `longpaths`, `precomposeunicode`, `quotepath`, `fscache`;
      - `extensions.*`;
      - `user.name`, `user.email`, `user.useConfigOnly`;
      - `remote.*.` `url`, `pushurl`, `fetch`, `push`, `tagopt`, `prune`;
      - `branch.*.` `remote`, `pushRemote`, `merge`, `rebase`;
      - `pull.rebase`, `pull.ff`, `push.default`.
    - Include directives themselves are refused.
    - The push and remote check also pass `-c protocol.allow=never`, then deny `ext`, `git` and `http` by name, and allow `https`, `ssh` and `file`. The named denies exist because a protocol-specific key in the user's global configuration would otherwise beat the generic one.
    - Remotes that name a network share are refused (decision 8): UNC, device and `file://host` forms, and drive letters that are mapped to a share or unavailable. The push refuses with "none"; a remote check stays unknown.
      - Git percent-decodes `file://` URLs, so any `file://` URL containing `%` is refused outright rather than decoded.
      - A local-path remote must sit on a fixed local drive with no link anywhere in its existing chain, checked without following one. A directory symbolic link could otherwise lead to a share.
    - The user's global configuration is theirs and is not screened.
    - **Cost:** a repository-local credential helper, `sshCommand`, proxy or include must move to the global configuration before the app pushes. A remote check under such a configuration stays unknown.
    - **Accepted limits (Rudy, 17 October 2026).**
      - A remote that is a local folder path runs that destination repository's own `receive-pack` hooks and configuration. Git's local transport does not pass this process's settings on; the independent review confirmed it with a probe. Rudy chose to allow local remotes and document this, rather than refuse them or harden the destination.
      - The configuration is screened just before the push, so a same-user process that rewrites it in between is not detected.
      - The independent review of the TypeScript port found that the destination's own layout (`<path>.git`, a gitfile, `alternates`) can also lead to a share.
        - Rudy decided on 17 October 2026 to refuse relative local-path remotes in both runtimes, because a relative path is how a project would name a destination it ships.
        - The two limits above now apply only to a fully qualified destination, which is the user's own. See "Publication hardening" in the dual-landed fixes.
    - **Independent review.**
      - The Store fix was GO.
      - The allowlist was NO-GO as first claimed, because of the local-remote hooks. Rudy's decision narrowed the claim, and the network-share refusal and the named protocol denies were added.
      - The re-review found that a percent-encoded `file:///%2F%2Fhost/share` URL still reached a share (medium, confirmed), and that a local path could lead through a symbolic link (low). Both are now refused, as above.
  - **Tests.**
    - `PushRefusesRepositoryConfigurationThatCouldRunPrograms` covers `credential.helper`, a URL-scoped helper, `core.sshCommand`, `remote.*.receivepack`, `protocol.*.allow`, `url.*.insteadOf` and an include. Each is refused with no program run and nothing pushed, and inert keys then push normally.
    - `PushTransportsAreLimitedToHttpsSshAndLocalPaths` checks the protocol restriction on the command line and that an `ext::` URL never runs.
    - `NetworkShareRemotesAreRecognized` classifies share spellings, including percent-encoded `file://` forms. `PushRefusesNetworkShareRemotes` refuses loopback UNC, `file://` and percent-encoded share remotes, so even a broken guard sends nothing off the machine.
    - `PushRefusesALocalRemoteReachedThroughALink` refuses a local remote behind a junction, then pushes through the real path.
    - Each of these failed its test: trusting every key, dropping the protocol restriction, dropping the share check, accepting `%`, or dropping the link check.
  - The TypeScript runtime had the same exposure. It now has the same checks; see "Publication hardening" in the dual-landed fixes.
- **Reconciliation, from the independent review (low).** Verification still trusted the worktree, so a replaced worktree with a crafted parent, message and clean tree could make an unknown commit reconcile as complete. **Fixed natively:** verifying a commit, and verifying a push whose commit was not recorded, apply the same worktree and binding check, and a mismatch stays unknown. Commit verification therefore also needs the project folder to be admissible. While it is unavailable, an unknown commit that TypeScript could resolve from the worktree alone stays unknown.
- **Tests:**
  - `TaskPublicationTests` covers a staged `git mv .env safe.txt`, a tampered binding, a replaced worktree with its own remote (nothing pushed there), a differing push URL, and a SHA-256 remote.
  - Every publication vector still replays unchanged.
  - Removing each guard failed its test.

### Folder-project chats (P2.2f)

**What it is.** The development runtime's `task.start` now accepts a saved project folder that is not a Git repository. The method count is unchanged at 34, because `task.start` was already served for projectless chats. It follows `service.ts` `startTask` in order:
1. An earlier request with the same ID is answered first.
2. A missing project is refused ("Project not found."), and so is a hidden one.
3. The saved folder must still resolve to the same physical folder under its saved spelling. It is classified while pinned, and its Git identity must be unchanged.
4. The mode, coordination and profile are checked.
5. The start is reserved, and the folder task and its first offline turn follow.

A folder chat turns exactly as a projectless one: `prepareRequest` gives it no tool, channel or system prompt. `task.send` and `task.cancel` serve folder chats too. A failed start is retried only when the task's saved project is still the requested, visible one and its folder still resolves. The task's own spelling must name that folder by identity.

**Messages now aligned with TypeScript.** A projectless chat in coding or coordinated mode is refused with TypeScript's "Coding and coordination require a Git project.", and coordination settings on a chat with its message; both were a native "not supported" before.

**Differences:**
- **Git-project chats.** `task.start` on a Git project is refused before any reservation. Every Git task's turn advertises project-channel tools, and coding adds approval-bound tools; both need the native tool loop of a later slice. This was left out of P2.2 in the approved plan. Git-project chats are served since P2.3e.
- **External profiles.** These remain refused for any turn, as before.

**Evidence.**
- `tests/p2/folder-chat.test.ts` drives the shipping `RuntimeService` with the offline provider, deterministic identities and a fixed clock through 21 steps:
  - adding the folder, starting, waiting, reading, listing files, a coalesced retry, and a second turn;
  - refusals for coding mode, coordination settings, hidden, missing and moved projects;
  - a restart in the restored folder;
  - a Git-project chat.

  After every step it pins the value or refusal, and the task, message, request, start, event and project rows and notifications, in `folder-chat-vectors.json`.
- `FolderChatTests` replays every step through `DevelopmentChat` with the same identities and clock. It reproduces each snapshot exactly. For the Git-project chat, the named difference, it required the refusal and an unchanged snapshot; since P2.3e it serves that chat and reproduces its snapshots.

**Finding outside this slice: the native Store pinned every ancestor of its data folder with read-only sharing. Fixed after P2.2, on Rudy's instruction (17 October 2026).**
- P1's Store admission pinned the data folder's whole chain through `DirectoryLease.Acquire`, which shares reads only.
- Renaming a file or folder needs its parent opened for writing. So while the native runtime ran, nothing could be renamed directly inside the data folder or any folder above it, up to the drive root. For data kept under the user profile, that included the profile folder itself.
- This was found while a test tried to rename a project folder beside the data folder. The slice's tests keep projects in a separate subtree.
- **Fix.** The Store's two long-lived leases (the requested chain and the admitted folder) now use `DirectoryLease.AcquireSharingWrites`, which shares writes and never deletes, as residual 3 did for project folders.
  - Other applications can rename and create entries anywhere in the chain again.
  - The pinned folders still cannot be renamed or deleted, and the database and isolation marker keep their own pins, so they cannot be renamed or replaced.
  - The short leases taken during admission inspection and the backed-up upgrade still share reads only.
- **Tests.** `AdmissionTests.AnOpenStoreLeavesItsFoldersOpenToRenamesButNotToReplacement` covers both sides. Restoring the read-only pin made it fail.

### Existing-file edit primitive (P2.2g)

**What it is.** `RepositoryService.PrepareEdit` and `ApplyEdit` port `prepareEdit` and `applyEdit` from `repository.ts`. They are **unwired**: no handler, tool, approval or protocol method reaches them, and the development runtime stays at 34 of the 89 methods. The native tool loop and the approval records that will call them belong to a later slice.
- **Prepare.** The checks run in TypeScript's order:
  1. The new content must be UTF-8 text of at most 64 KiB, with no NUL.
  2. Creating a file is refused: there must be a reviewed hash.
  3. The root is admitted and the relative path rules apply.
  4. The parent must already exist.
  5. The file must be readable UTF-8 text whose hash is the reviewed one.
  6. The file must not be hard-linked.

  The fingerprint is the SHA-256 of the JSON array `[root, path, expectedHash, resultingHash]`. The path keeps the request's spelling beneath the real root, as in TypeScript; the applied result reports the real one.
- **Apply.** It reruns the whole preflight and requires the same fingerprint. A tampered or replayed approval, or a file changed after review, is therefore refused before anything is written. Once written, the content no longer matches the reviewed hash, so one approval applies once. An unchanged edit can apply again, because it writes identical bytes.
- **Write boundary.** The file is opened by its exact name, without following a reparse point, for one exclusive rewrite (the new Platform `ExistingEntry.TryOpenForRewrite`). Other handles may still read it if they share writing. No other writer, rename, delete or replacement of the file, and no rename of its folders, can start while it is held.
  - Under that hold, native checks that the file is regular and has one link, that its bytes are the reviewed ones, and that its name still resolves to the same file identity (FileIdInfo).
  - It then writes from the start, cuts the length, flushes to disk, and verifies the result by name, still under the hold.
- **Outcomes.** A failure before the write is "none". From the write on, any failure is "unknown", including a verification that does not find the reviewed result.

**Differences, all fail-closed or invisible on success:**
- Local aliases are refused (the approved difference).
- Node's raw filesystem errors become fixed messages. A missing file becomes "Requested path does not exist.", and a read-only file at execution becomes "Requested file cannot be opened for editing.", with the same "none" outcome.
- **Exclusive write window.** A file that another handle can already write or delete is refused at execution, where Node's shared open proceeds. Native holds the file exclusively from the content check to verification. TypeScript instead re-checks the name's identity before writing and verifies after closing.
- At execution, the content is read bounded (64 KiB plus one byte), and a larger file is refused as changed. TypeScript reads it whole and then refuses it on the hash.

**Evidence.**
- `tests/p2/existing-file-edit.test.ts` drives the shipping `RepositoryService` directly through **23** cases (76 steps: 51 prepares, 19 applies, and external writes, renames, removals, hard links and read-only flags between them). The cases cover:
  - plain edits, empty content, byte order marks and carriage returns, and non-ASCII text;
  - backslash and case-variant paths, and a case-variant root;
  - the 64 KiB limit counted in UTF-8 bytes, and NUL;
  - creation, stale hashes, forbidden, absolute and escaping paths, and roots that are not working directories;
  - directories, missing files and parents, binary and oversized files;
  - a linked parent and hard links, before and after review;
  - tampered, stale, replayed and unchanged approvals;
  - removal, read-only and a same-content swap after review;
  - a Git working tree and its metadata.

  It pins every outcome, each prepared edit (with its fingerprint's preimage checked against the hash), and the final bytes of every file in `existing-file-edit-vectors.json`. It is bound to the SHA-256 of `repository.ts` and `network-path.ts`. Regenerating the vectors requires `P2_WRITE_EXISTING_FILE_EDIT=1`.
- `ExistingFileEditTests` replays every case through the native primitive. Where Node raised a raw error, it pins native's own message and requires the same outcome. Native-only tests prove four things:
  - another writer is refused before anything is written;
  - at the write boundary, writing, renaming, replacing or deleting the file, and renaming its folder, are all refused;
  - failures are classified by whether the write started;
  - the primitive requires the owning loop.
- Mutations were caught. Opening the rewrite with full sharing failed the two exclusivity tests. Skipping the fingerprint comparison failed the tampered-approval case.

**Independent review of P2.2f, the H1/L1 fixes and P2.2g.** The same reviewer (`cloud-security-vulnerability-expert`, Opus at high effort below the xhigh owner) reviewed four sealed ranges: `f199fd1..df2d46c`, `df2d46c..9116b45`, `9116b45..b0a27fd` and the documentation commit `b0a27fd..a8fa711`. It returned **GO for all four**, with no critical, high or medium finding.
- **What it did.** It verified every seal, built an export of `a8fa711`, and ran the publication, runner, edit, folder-chat and creation suites (93 passed). It confirmed that Git 2.53 has no `hook.*` setting that bypasses `core.hooksPath`.
- **What it confirmed:**
  - folder `task.start` follows `startTask`'s order, and a Git-project chat is refused before any reservation;
  - the H1 guard covers every native launch, and its refusals keep TypeScript's outcome classification;
  - L1 cannot deadlock or strand a reservation;
  - the edit primitive matches `repository.ts` in order and messages, and nothing is written before the fingerprint and content checks;
  - its exclusive window holds, `RandomAccess` is valid on the synchronous handle, and nothing in `DevelopmentChat`, `Program` or the protocol reaches it.
- **H1-i (informational).** The runner's comment claimed the pinned hooks folder could not be swapped for a link while held. A pin that shares writes cannot forbid attribute changes, so a same-user process could turn the folder into a link in place during a run. The check after exit and the next launch's probe both still refuse it. Corrected: the comment and the H1 entry above now state the limit.
- **G-i (informational, parity), not changed.** A shrinking write that is followed by a failed length cut leaves the new start plus the old tail. It is classified unknown, as in TypeScript, so it is never reported as success.
- **Also noted.** The P1 Store chain pin recorded under P2.2f should be fixed before any shipping selector. It has since been fixed (see P2.2f).
- **Re-review of the H1 alignment.** The ranges were `a8fa711..6310817` (comment and docs) and `6310817..26a8e4a`, the native guard aligned with the TypeScript fix. The reviewer returned **GO for both, with no finding at any severity**.
  - It verified both seals, built `26a8e4a`, and ran the runner, publication and creation suites (64 passed).
  - It confirmed that the check order and messages match `assertNoGitHooks` and `git()`'s `finally`, and that native's additions only add refusals.
  - It confirmed that the check after exit runs on every path once Git has started and never makes an earlier mutation look like "none", that every lease is disposed, and that no native launch can pass an empty `core.hooksPath`.

### P2.3 commands and approvals — authority and slices

Recorded 17 October 2026. Rudy approved the slice plan: "Approved: P2.3 slices a–f with decisions 1–5 as recommended. Start P2.3a." The slices, each sealed, reviewed and recorded on its own:
- **a:** the native command runner, unwired;
- **b:** approval records, the approval read projections and `approval.reconcile`;
- **c:** the tool runtime for the repository tools and approval decisions, unwired;
- **d:** the project channel, with `channel.get` and `channel.send`;
- **e:** agent-loop tool iterations and Git-project chats (`task.start`, `task.send` and `task.cancel`);
- **f:** coding turns with approvals, and `approval.decide`.

**Decisions.**
1. The project channel and its two methods move into P2.3; the migration plan had placed the channel in a later slice. Every Git task's turn advertises channel tools.
2. Until the MCP slice, a coding turn is refused before any reservation while an enabled MCP server has stored tools.
3. The plan's runtime-loader environment names (section 8) are refused natively only, as a named difference. TypeScript is unchanged under the freeze.
4. #35 (the TypeScript H1 fix, which changes `command-runner.ts`) merges before P2.3a's vectors are final; #37 lands before P2.3c.
5. Local commits and a seal per slice; one draft pull request for the stack on Rudy's approval, merged on his approval.

Every other hold is unchanged: no shipping or runtime selector, no Electron-side .NET enablement, no schema v6 or adoption, no real data or repositories, no live or paid providers, no coordinated mode, no cutover. New-file creation stays disabled. Commands run with the user's Windows privileges; approval is not a sandbox.

### Native command runner (P2.3a)

**What it is.** `CommandRunner` is internal and unwired, the native counterpart of `command-runner.ts` and its `job-runner.ps1` helper. Nothing in `DevelopmentChat`, `Program` or the protocol calls it, so the development runtime stays at 34 of the 89 methods.
- **Preparation**, in TypeScript's order and with its messages:
  1. The request is validated.
  2. The root is admitted, with its folder and Git identity pinned.
  3. The working directory is pinned and must stay inside the root.
  4. Windows PowerShell 5.1 is resolved and hashed.
  5. The minimal environment is composed in `localeCompare` order.
  6. The worktree state is read: HEAD, porcelain status and a content digest of at most 10,000 files and 64 MiB.

  The fingerprint covers all of it.
- **Execution.**
  - **One shot.** A prepared command is consumed before the first await, prepared again and required to match.
  - **Launch.** It runs in process through `JobProcess`, with the helper's command line (`-EncodedCommand`, UTF-16LE Base64). Only the three pipe ends and the reviewed environment block are passed.
  - **Termination.** A timeout or cancellation terminates the job. After a normal exit, anything still in the job is terminated, and reported with TypeScript's marker unless it is only the console host (below). Cleanup is verified when the job is empty within 5 seconds.
  - **Output.** Each stream keeps its first 64 KiB, is drained to its end on the thread pool, and is bounded again to 64 Ki UTF-16 units, as `boundedText` does.
  - **Settle window.** Everything after the command ends is bounded by 10 seconds, TypeScript's `HELPER_GRACE_MS`. Examples are an exit that never comes, a cleanup check, and a pipe write end held outside the job. When the window ends, the drains are cancelled, and the result keeps the output read so far with cleanup unverified, so the tool runtime records it as unknown.
- **Outcomes.** Every failure through launch is a `CommandPreflightException` ("none"). Results report the exit code, cancellation, timeout and verified cleanup as TypeScript's do; the tool runtime (P2.3c) classifies them.

**Differences, all fail-closed or invisible on success:**
- **In process.** There is no helper, `%TEMP%` file, nonce or `Add-Type`. The runtime owns the kill-on-close job (plan section 8), so TypeScript's "[runtime parent exited; job terminated]" result cannot occur. The timeout counts from resume. The settle window replaces TypeScript's watchdog (timeout plus 70 seconds), which reports such a run as timed out, with no output.
- **Handles.** Only the pipe ends are inherited (`HANDLE_LIST`); `job-runner.ps1` inherits every inheritable handle.
- **Console host.** Windows starts a `conhost.exe` for the command inside its job; TypeScript's command shared its helper's console instead. Measured: 2 of 30 runs left the console host for a moment after the root exited, and 1 had exited between listing and opening. Without a filter, about 1 command in 15 reported a phantom descendant.
  - **What happens now.** After the root exits, anything left in the job is terminated. It is reported as a background descendant unless the only processes left are the system `conhost.exe`.
  - **Classification.** The new Platform `JobProcess.ProcessImages` leaves out a process that has exited: its id no longer opens, or its exit code is set. A live process whose image cannot be read counts as a descendant.
- **Exact command text.** Until #39 (T1, below), TypeScript's helper read its stdin spec in the console code page, so non-ASCII command text reached PowerShell altered. Native runs the exact text. Since #39 both runtimes run it exactly, and the vectors show no difference.
- **Runtime-loader names (decision 3).** `DOTNET_*`, `COMPLUS_*`, `COR_*` and `CORECLR_*`, plus `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT` and `__COMPAT_LAYER`, are refused before approval, ignoring case.
- **Case-only duplicates.** A change whose name differs only in case from another change, or from `TEMP`, `TMP` or `USERPROFILE`, is refused before approval. TypeScript prepares it; its helper then fails before launch, and the outcome is recorded as unknown.
- **Launch failures.** A launch that fails before the process resumes is "none". An example is a command line beyond `CreateProcess`'s 32,767 characters, about 12,200 command characters. TypeScript's helper cannot tell, and records unknown.
- **Working directory.** Any reparse point in its chain is refused (the approved alias refusal); TypeScript follows a junction that stays inside the root. A segment ending in a dot or space, a colon, or NUL is refused, where Node raises a raw error.
- **Worktree state.**
  - **Git.** It runs through `GitRunner`, with the app's empty hooks folder and the H1 guard, and never an empty `core.hooksPath`.
  - **Content digest.** It runs off the loop (the first use of `RuntimeLoop.Offload`) and never follows a reparse point. Symbolic links and junctions are hashed by their stored target, as TypeScript hashes `readlink`. Any other reparse point (a cloud placeholder, a socket) refuses the state, where Node reads through it.
  - **Walk.** It keeps its own stack in TypeScript's pre-order, so a deep tree cannot exhaust a thread's stack. Folders and links count against their own limit of 10,000, where TypeScript counts files only.
  - **Fingerprints.** The values differ between runtimes. They are session-scoped, because approvals awaiting a decision are revoked on restart, so the corpus compares them by identity within a case.
- **Other refusals.** A `SystemRoot` that is not on a fixed local drive is refused before it is probed, and Node's raw errors become fixed messages.

**Evidence.**
- `tests/p2/command-runner.test.ts` drives the shipping `CommandRunner` with real Windows PowerShell 5.1 runs in disposable worktrees, through 13 cases and 193 steps, 36 of them executions:
  - validation, and root and working-directory admission;
  - environment composition and its fallbacks;
  - fingerprint sensitivity: modification time only, content, ignored files, empty folders, Git metadata, commits and junction retargeting;
  - the file and byte limits, and a Git status beyond the output limit;
  - exact output, exit codes and environment isolation (a runtime canary is absent);
  - output bounds: 65,535, 65,536 and 70,000 bytes, multibyte cuts, and 1 MiB drained;
  - timeout, cancellation and background termination with a grandchild;
  - one-shot use: replay, concurrent execution, tampering with each field, discard, stale state and identical twins.

  It is bound to the SHA-256 of `command-runner.ts` and `job-runner.ps1`. Regenerating the vectors requires `P2_WRITE_COMMAND_RUNNER=1`. Commands use .NET calls only: a cmdlet makes PowerShell write a timing-dependent number of "Preparing modules for first use" progress records to standard error.
- `CommandRunnerTests` replays every step, or its named difference. Native-only tests cover:
  - a planted hook, which refuses preparation with no Git launch;
  - state Git calls that name the hooks folder;
  - a launch that is exactly the reviewed command line, directory and environment;
  - a launch failure, which is "none";
  - cancellation before launch, which never launches;
  - a timeout that ends a grandchild;
  - the console host, which is not a descendant: the decision as a pure function, and 40 real runs;
  - a pipe write end held outside the job (the command hands its standard output to the test process): the result returns within the settle window, keeping the output, with cleanup unverified;
  - a 3,000-folder-deep tree, which is fingerprinted, and 10,001 folders, which are refused;
  - a caller's later edit of the environment changes, which cannot alter the approved command;
  - loop affinity, and Node's `join` and `dirname`.
- `JobProcessTests` covers the new Platform primitives: `ProcessImagesNameTheRootAndItsConsoleHost`, and `DrainKeepsItsLimitAndCancellationEndsAPendingRead`.
- **Mutations.** Each of these failed a test:
  - consuming the capability after the first await;
  - skipping the fingerprint comparison;
  - stopping a stream at its limit instead of draining it;
  - dropping the runtime-loader names;
  - dropping the case-collision refusal;
  - hashing Git metadata into the content state;
  - counting the console host as a descendant.

  The last one first ran against the real-run test alone, which is probabilistic (the host lingers in about 1 run in 15) and passed that time. The decision is now a pure function under a deterministic test.

**Independent review.** A read-only security reviewer (`cloud-security-vulnerability-expert`, Opus at high effort below the xhigh owner, chosen for the security verdict) reviewed the sealed range `91ac821..36ad511`. It verified the seal, built an export, and ran the runner and job suites (34 and 28 passed). Its probes confirmed T1. Its verdict was **GO with conditions**: F1 and F2 to be fixed, with regression tests, before any slice wires the runner. The approval-integrity core was found sound: no path runs anything but the freshly re-prepared command, and none reports a started command as "none".
- **F1 (medium).** Nothing bounded `Execute` after launch. A pipe write end handed to a process outside the job kept the drains open even after `JobProcess.Dispose`, because synchronous pipe reads ignore disposal. A process stuck in I/O that cannot be cancelled kept the exit wait open. TypeScript's watchdog bounds both.
  - **Fixed.** The settle window above bounds everything after the command ends. The drains take a cancellation token: probed, .NET cancels a pending synchronous pipe read in about 1 second. When the window ends, cleanup is unverified.
- **F2 (medium).** The content walk recursed with no depth bound. The reviewer's probe crashed the process with a stack overflow at about 3,000 levels, which a cloned repository or an earlier command could leave. Node's async recursion has no such limit.
  - **Fixed.** The walk keeps its own stack in the same pre-order, and folders and links count against a limit of 10,000.
- **F3 (low).** After a normal exit, the job was terminated only when a readable image other than the console host remained. A live process whose image could not be read was treated as exited, so a descendant could outlive the root for the cleanup window without being reported.
  - **Fixed.** Anything left in the job is terminated. `ProcessImages` now tells an exited process from an unreadable live one, which counts as a descendant.
- **F4 (low).** Every 16 KiB of output queued a continuation on the runtime loop.
  - **Fixed.** The drain moved into Platform (`JobProcess.DrainAsync`), where its continuations stay on the thread pool. `ConfigureAwait` is banned in `Runtime.Core`.
- **F5 (informational).** `JobProcess.Start` built its streams after resuming the child. **Fixed:** they are built before, so every exception from `Start` means the child never ran.
- **F6 (informational).**
  - The process specification is now built inside the block that releases the leases.
  - Not changed:
    - the removal of a re-approved identical command after a run (fails closed, as in TypeScript);
    - the unpinned walk (it affects only the hash, as in TypeScript).
  - **Noted for P3:** any native launcher in the WebView2 or WPF process that inherits handles without a handle list could capture the pipe ends.
- **Mutations of the fixes.** Each of these failed its regression test:
  - removing the settle bound on the drains (the test hung until its timeout);
  - removing the folder limit;
  - restoring the reviewed recursive walk (a real stack overflow ended the test process);
  - counting an unreadable image as exited.

  The always-terminate rule (F3) and stream construction before resume (F5) have no deterministic trigger: an unreadable live descendant, or a stream that fails to construct. They rest on review.
- **Re-review.** The same reviewer reviewed two sealed ranges and returned **GO, with no new finding**:
  - `7df623a..18c4881`, 36ad511 rebased onto #37 (every code, test and vector blob identical);
  - `18c4881..38ce289`, the fixes.

  What it did:
  - It verified both seals, built an export, and ran the job suite (29 passed) and the runner suite (37 passed).
  - It hashed the same trees with both builds: the iterative walk gives the reviewed recursive walk's digest on a mixed tree and on a 1,000-deep chain.
  - It found that the walk now handles depths of 3,000 and 9,000.

  Its informational residuals:
  - After the drains are cancelled there is no second bound. It relies on .NET cancelling a synchronous pipe read, which the Platform test shows it does.
  - A folder's names are read whole before a limit applies, as in TypeScript.
  - The outside-writer test's 60-second bound was loose; `81823ca` tightens it to the settle and cleanup windows plus 15 seconds.

  Carried forward:
  - P2.3c must record a settle-window result (exit code 0, cleanup unverified) as unknown.
  - Handle inheritance by other launchers is re-checked at P3.
- **T1 amplification (untested).** Under a double-byte OEM code page such as 932, a UTF-8 trail byte could combine with the next ASCII byte and change a command's structure, not just its literals.
- **Evidence manifest.** It was stale during the run and has since been regenerated.

**Validation (local, from `git archive` exports).** Evidence, seals and mutation logs are in `foundry-evidence\p2.3-a`.
- **`36ad511` (run1).**
  - Release build with warnings as errors: clean.
  - Native suite: 7,151 tests, 7,149 passed, 0 failed, 2 expected skips.
  - `pnpm check`: 556 passed.
  - `git diff --check`: clean.
- **`38ce289` (run2, retained).** Two failures, both in code this slice does not touch, while the reviewer's build and tests ran on the same machine:
  - the native WebView2 test `BasicAuthenticationIsCancelledWithoutAPrompt` (two requests where one was expected);
  - the TypeScript `git-operations` handoff-commit case (a 30-second timeout, then `EBUSY`; P2.1 recorded the same flake under load).

  Run alone, both passed (1/1 and 27/27).
- **`81823ca` (run3, idle machine).**
  - Build: zero warnings or errors.
  - Native suite: 7,179 tests, 7,177 passed, 0 failed. The 2 skips are the expected local registry-policy test and the file-symbolic-link test.
  - `pnpm check`: 556 passed across 85 files.
  - `git diff --check`: clean.

No renderer, IPC or user-path source changed, so no Electron E2E run was required.

**Dependencies, resolved.** #35 (H1) and #39 (the T1 fix) merged on 17 October 2026, and main was merged into this branch. The vectors bound to `command-runner.ts` and `job-runner.ps1` were regenerated:
- **#35** changed only the source hash.
- **#39** brought TypeScript to native's outcome at "runs exactly the approved command#12" and "#14", so those named differences were removed. `CommandRunnerTests` passes 37 of 37.

**T1 (shipping TypeScript, fixed by #39).** `job-runner.ps1` reads its JSON spec with `[Console]::In.ReadToEnd()`, which decodes in the console's OEM code page while Node writes UTF-8.
- **What breaks.** Every non-ASCII character in the command, its environment values, its working directory or the result and cancel paths reaches the helper altered. An approved `'café'` runs as `'caf├⌐'`, so the command that runs is not the one approved; a filter or path with non-ASCII text matches different files.
- **Non-ASCII user folders.** Where the user's profile path is not ASCII, the working directory and temporary paths are altered too, so no command can launch. Each is then recorded as unknown and blocks its task.
- **Status.** Fixed under the dual-landing rule by #39, which reads standard input through a strict UTF-8 reader (security review GO; merged 17 October 2026). Native was not affected.
- **Shared limit.** PowerShell encodes command output in the console code page and both runtimes decode it as UTF-8, so non-ASCII output becomes U+FFFD in both. That is a shared fidelity limit, not an approval defect.

**Reviewer probe debris.** The first review's deep-tree probe wrote 14 small untracked files (`content 1` to `content 14`) into the worktree root, though it was told to work read-only in its own export. No tracked file changed. They were removed before P2.3b, and the evidence folder records them (`notes\reviewer-probe-debris.txt`).

### Approval records and reconciliation (P2.3b)

**What it is.** With `FOUNDRY_RUNTIME_P2_CHAT=1`, the development runtime now serves `task.approvals`, `approval.get`, `approval.content` and `approval.reconcile`, bringing it to **38** of the 89 methods. The Store reads and saves approvals as `store.ts` does. The new `ToolRuntime` holds reconciliation; the tool execution and decision paths join it in later slices.
- **`task.approvals`.** The task's approvals, newest first, are keyed by rowid in the same SQL. Each item has the id, task, tool, the row's state, the creation time and the path; fields absent from the stored document stay absent.
- **`approval.get`.** The whole document is redacted, then parsed back from the redacted text.
  - When it fits in 128 KiB, it is returned whole.
  - Otherwise a preview is returned: its identity, hashes, binding and origin, with the summary and path clipped to 1,000 bytes and the omitted fields named.
- **`approval.content`.** One field (or the whole redacted document) is returned in a UTF-8-aligned chunk of at most 32 KiB.
- **`approval.reconcile`.** Only an unknown outcome of the same task can be checked, and nothing is replayed.
  - **Edits.** The file in the task's worktree is compared by hash. The approved content completes the edit, and the original content fails it. Anything else, including a file that cannot be read safely, leaves it unknown.
  - **Everything else.** Commands, external tools, browser actions and orchestration operations stay unknown, with TypeScript's guidance.
- **Events.** The approval is saved with its `approval.changed` event as `service.ts` records it:
  - before schema v5, always;
  - from v5, when the state changed, or when the task has no such event yet, because the publish falls back to recording one.

  `approval.changed` is now among the notifications the development runtime sends.

**Differences, all invisible on success or fail-closed:**
- **Re-sent notifications.** When a reconciliation leaves the state unchanged and the task already has an `approval.changed` event, TypeScript re-sends that earlier event (its canonical re-read), and native sends nothing. This is the approved publication-after-commit difference, and the durable rows are identical.
- **One commit.** The saved approval and any event recorded after it commit together; TypeScript commits them separately.
- **Aliases.** An edit is reconciled through native file access, so a worktree reached through an alias cannot be checked: the approved alias refusal, which leaves the outcome unknown.
- **Malformed rows.** A stored approval that is not a JSON object (not valid JSON, or valid JSON of another kind) faults the request. That ends the development runtime, as every native read of malformed persisted data does. TypeScript answers with an error, or with a document spread from the value. Both runtimes' pages skip such rows. Neither runtime ever writes one.

**Evidence.**
- **The oracle.** `tests/p2/approvals.test.ts` drives the shipping `RuntimeService` over fresh data and disposable copies of all six fixture eras. It seeds four tasks (one a coordinated child) and 31 approval rows covering:
  - edits, commands, rejected and secret-bearing approvals;
  - a 140,000-byte approval with a multibyte summary and long path (preview);
  - external tool, browser, handoff and integration approvals;
  - unknown edits whose file holds the approved content, the original, neither, or nothing;
  - lone surrogates, a document without a stored state, and a row that is not JSON;
  - since the L1 fix, secret-bearing, large and unparseable-when-redacted unknown approvals.

  It pins, in `approval-vectors.json`:
  - every era's own approvals (each fixture era since v1 holds approved and rejected coding demos), with pages and reads;
  - a full keyset traversal at limit 2;
  - 138 reads (pages, previews, every field, offsets inside multibyte characters, out-of-range offsets, absent fields and foreign tasks), proving the rows unchanged;
  - 30 reconciliations, each with the approval row and every event row it adds. Among them are an origin on a state change, a child task's event (`root_task_id` is its root), a row that recovery left with a stale document state, a document with no state, integer-like keys and unusual numbers (`1e21`, `-0`, a 20-digit integer), and a lone surrogate on the write path.

  It is bound to the SHA-256 of `workspace-queries.ts`, `tool-runtime.ts`, `store.ts`, `service.ts`, `redaction.ts` and `repository.ts`. Regenerating the vectors requires `P2_WRITE_APPROVALS=1`.
- **The replay.** `ApprovalTests` seeds the same rows into the same copies and replays every step through `DevelopmentChat`. Values, refusals, approval rows and event rows (sequences included) must match. A native-only test pins the malformed-row difference.
- **Process differential.** The real Node/C# stdio differential (`tests/p2/development-chat-process.parity.ts`) now also calls each approval method. The two entry points agree on the empty page, the missing-task refusal and the missing-approval refusals.
- **Mutations.** Each of these failed the replay:
  - dropping the event when the state changes (v5);
  - dropping the fallback event, and dropping the pre-v5 event;
  - returning the unredacted document;
  - ignoring UTF-8 boundaries in chunks;
  - ignoring the approval's task, in reads and in reconciliation;
  - failing an edit whose file cannot be read.

  The first mutation's original edit did not build (unreachable code); its rerun was caught. After the review follow-ups, dropping the event's `origin` also fails the replay, in the three v5 eras.

**Independent reviews of `48c5eb8..f9f40ae`.**
- **Security** (`cloud-security-vulnerability-expert`, Opus at high effort): **GO**. It verified the seal, built an export and ran the replay (9 passed), and compared the code line by line with TypeScript and the renderer's call site.
  - **Confirmed.**
    - All three read methods redact everything they return.
    - Cross-task access is refused on all four methods.
    - Reconciliation can read only inside the worktree, through the pinned, link-refusing file access, and decides an outcome only on a hash match.
    - The contract bounds every parameter before dispatch.
  - **L1 (low, shared with shipping TypeScript; Rudy's decision).** `approval.reconcile` returns the stored approval unredacted, where the three read methods redact. The renderer's only call discards the value and refreshes, so nothing is retained today. A fix would return the redacted read in both runtimes; native keeps parity until then.
    - **Fixed in both runtimes, 17 October 2026**, on Rudy's decision: see "Redacting the approval `approval.reconcile` returns" under Dual-landed fixes.
  - **I1 (condition for P5, not for this slice).** A corrupt stored approval ends the native runtime. Before a shipping selector, read projections must refuse malformed persisted documents per request.
  - **I2–I5 (parity, no action).**
    - Page items are not redacted (paths were screened at creation).
    - The two not-found messages tell an existing approval from a missing one.
    - Redaction that breaks the JSON fails closed.
    - Reconciliation trusts the task's stored worktree path (worth confining when the tool runtime grows).
- **Data integrity** (`db-steward`, Sonnet at high effort): **GO**. It verified the seal, built an export, ran the replay and the TypeScript oracle, and probed both runtimes directly: 40 reconciliations against fresh, v1, v4 and v5 stores, with 0 differences in stored text, state, events, errors or reads.
  - **Confirmed.**
    - Era event semantics, with root task ids at v5.
    - Byte-identical document round-trips.
    - Keyset stability.
    - Recovery interplay.
    - Atomicity: an aborted event insert leaves the row unchanged and the store usable.
  - **Follow-ups applied in the next commit.**
    - **L1.** The malformed-row note and test now cover every non-object document.
    - **L2.** The oracle gaps it found are now cases: origin, child root id, a recovery-shaped row, a document with no state, unusual numbers and keys, and a lone surrogate on the write path.
    - **L3.** One `ToolRuntime.Save` now mirrors `save()` plus `publish`, so later slices cannot skip the v5 fallback event.
  - **Not changed.**
    - **L4.** A row whose document names another id would overwrite that row. TypeScript is the same, and only corrupt data reaches it.
  - **Carried forward.**
    - The automation slice decides whether TypeScript's re-sent `approval.changed` matters to hooks.
    - P2.3c and P2.3f add a compare-and-set to approval saves once execution is asynchronous.
    - Corrupt-data divergences in clipping and type checks.
- **Follow-up re-review of `f9f40ae..f519a93`** (data reviewer): **GO, no new finding.**
  - It verified the seal and ran the replay (9 passed) and the TypeScript oracle.
  - It confirmed that the new vectors pin each gap it had named.
  - Five mutations of its own failed the replay: dropping the origin, ignoring the task in the fallback check, using the document state instead of the column, hard-coding the event state, and a wrong root task id.
  - Its 40-case direct differential, rerun on `f519a93`, shows 0 differences.
  - `Save` takes the event's approval id from the document, as `save()` does.
- **Validation.**
  - **`f9f40ae` (run1).** Native suite 7,212 passed, 0 failed, 2 expected skips; `pnpm check` 570 passed; stdio differential passed.
  - **`f519a93` (run2).** Native suite 7,212 passed, 0 failed, 2 expected skips; `pnpm check` 570 passed.
  - **Common to both.** Clean Release builds with warnings as errors, from `git archive` exports. Evidence, seals and mutation logs are in `foundry-evidence\p2.3-b`.

### Coding tools and decisions (P2.3c)

**What it is.** The native `ToolRuntime` gains TypeScript's `execute`, `awaitDecision`, `decide` and `revokeWaiting` for the six repository tools of an ordinary coding task. It is unwired: no RPC, turn or decision reaches it, and the development runtime still serves **38** of the 89 methods.
- **Definitions.** `ToolDefinitions.All` is `TOOL_DEFINITIONS` byte for byte (the six tools, as `z.toJSONSchema` writes them for draft-7).
- **Arguments.** `ToolDefinitions.Parse` reproduces zod 4.6.5 for exactly these schemas: the parsed value with defaults, or the text the model receives, `JSON.stringify(issues, null, 2)` with zod's English messages. It covers:
  - shape order, then unrecognized keys in JavaScript key order;
  - string lengths counted in code points once over a limit;
  - JavaScript-exact patterns;
  - record keys checked before their values, and a `__proto__` key passed over;
  - the safe-integer and range checks;
  - the length checks zod runs even after a type issue, on any value with a `length`, compared with JavaScript coercion.
- **Search.** `RepositoryService.Search` is `search()`: depth first over the read tools' own listing and reading; 2,000 visits; 100 matches; 500-unit excerpts; and the five skipped folders.
- **Slots.** `ExecutionSlots` is the chat's three slots as their own class. Provider requests and approved tool executions share one instance, as in `service.ts`. Waiting for a decision never holds a slot.
- **Execution.**
  - **Order.** TypeScript's checks, in its order: cancellation, browser tools, Git task, chat mode, coordinated roles, the tool name, secret screening of the arguments, then the schema.
  - **Read tools** answer at once.
  - **Edits and commands** are prepared, screened for secrets again and saved as a proposal. The proposal waits for its one-shot decision.
  - **Mutation.** Once approved, the executing state is saved before any write or launch, inside a slot.
  - **Outcomes** are classified as TypeScript classifies them. After the executing state, an outcome is unknown unless the failure is known to precede any effect. A cancelled wait is revoked; a rejection or revocation answers the model with TypeScript's text.
  - **Results** are redacted and bounded to 192 KiB of UTF-8.
- **Decisions.** `Decide` requires the waiting call, its task and its nonce, and refuses a coordinated approval. `RevokeWaiting` revokes one task's waiting proposals.

**Differences, all fail-closed or invisible on success:**
- **Not yet served.** These answer "Tool is not available." until their slices:
  - the project channel's tools (served since P2.3d);
  - coordinated roles, which are refused before any reservation;
  - external MCP tools (decision 2);
  - hook-origin drafts.

  Browser tools answer "Browser tools are unavailable.", as TypeScript does without a browser host.
- **Unexpected failures.** A failure other than the runtime's own refusals is classified and saved like any other, then rethrown instead of being handed to the model as text.
- **Node's raw filesystem errors** (seven cases in the vectors) are native's fixed messages.
- **Search** admits the root once and holds it for a walk off the loop. TypeScript admits it again for every listing and read.
- **Revocation timing.** TypeScript's abort listener revokes a waiting proposal synchronously. Native revokes when the wait resumes on the loop, and until then `Decide` refuses the cancelled wait as stale. The rows and answers are the same; the vectors pin a decision sent right after a cancellation.
- **Not ported.** The per-profile slot key (coordinated tasks only) and the orchestration hooks.

**Evidence.**
- **The oracle.** `tests/p2/tool-runtime.test.ts` drives the shipping runtime: the definitions; 269 argument parses; 19 searches over three trees (skipped folders, binary, oversized and secret files, CRLF and lone CR, excerpts cut inside a surrogate pair, the match and visit limits); 57 tool calls of ordinary, chat, folder and legacy tasks through `RuntimeService`'s `ToolRuntime`, with real Windows PowerShell 5.1 commands in disposable Git repositories; and six decisions on stored approvals no call awaits. The tool calls cover:
  - reads and refusals, invalid and secret-bearing arguments, and the result bound;
  - edits: approve, reject, wrong nonce, other task, missing approval, stale hash, non-unique and overlapping text, `$` patterns, secret-like content in the arguments, in the file and in the result of the edit, a file changed while waiting, and cancellation before and after approval;
  - a decision sent right after a cancellation, and `revokeWaiting` of this task and of another;
  - commands: complete, failed, rejected, refused at preparation, a changed worktree, a timeout, cancellation, and a prepared command whose temporary folder is secret-like.

  It records each result, proposal, decision, approval row and event row. Paths, the shell, fingerprints, UUIDs and timestamps become placeholders; the clock is real, because the command helper checks its parent's start time. The vectors are bound to the SHA-256 of `tool-definitions.ts`, `tool-runtime.ts`, `repository.ts`, `command-runner.ts`, `job-runner.ps1`, `redaction.ts`, `store.ts`, `service.ts` and `execution-slots.ts`. Regenerating them requires `P2_WRITE_TOOL_RUNTIME=1`.
- **The replay.** `ToolRuntimeTests` replays every section natively. Every raw Node error has a native refusal, and the map is exhaustive.
- **Native-only tests.** `ToolRuntimeNativeTests` covers:
  - the refused channel tools and coordinated roles;
  - an unexpected launch failure saved unknown and rethrown;
  - an unexpected failure before any proposal, which leaves no row;
  - an edit whose write began before the failure, left unknown;
  - a command that exits 0 while its output handle is held outside its job: unknown, with cleanup unverified (review L-1);
  - three slots, and a cancelled waiter that takes none.
- **Mutations.** 34 native mutations.
  - **First run: four survived, because no fixture reached them.** They were edit-content screening, prepared-command screening, `revokeWaiting`'s task filter and JavaScript key order. Four new cases now reach them, and each of these mutations fails the replay. The replay also bounds each call's wait at two minutes, so a call that proposes where it should refuse fails rather than hanging.
  - **After the review's L-1 test, 33 of 34 fail.** The one that survives by design drops the cancellation check after approval, which the slot repeats.
  - **Evidence** is in `foundry-evidence\p2.3-c\mutations`.

**Validation.** All runs are from `git archive` exports, with a locked restore and install, a Release build with warnings as errors, and a clean `git diff --check`. Evidence and seals are in `foundry-evidence\p2.3-c`.
- **`362e728` (run1: the slice, the regenerated vectors and this record):** native 7,228 passed, 0 failed, 2 expected skips; `pnpm check` 581 passed.
- **`39eda38` (run2: after merging main at `1b88ff8`, which carries #41 and #43):** native 7,228 passed, 0 failed, 2 expected skips; `pnpm check` 581 passed.
- **`1472a70` (run3: with the review's L-1 test):** native 7,229 passed (the L-1 test included), 0 failed, 2 expected skips. `pnpm check` first failed one test: `publish.test.ts`'s push case took 40 seconds against its 30-second timeout. That load-sensitive test has also timed out in other sessions today, and this range changes no TypeScript. Its rerun in the same export passed 581 of 581.

**Independent review** (`cloud-security-vulnerability-expert`, Opus at high effort): **GO** for `089e894..e258793` and `5730c1d..362e728`. It verified both seals, built an export, ran the four replay classes (62 passed), audited the docs merge, and compared the code line by line with TypeScript.
- **Confirmed.**
  - Only the exact reviewed edit or command can run.
  - The executing state is durable before any mutation.
  - Every failure path is classified as TypeScript classifies it, and startup recovery covers a crash in between.
  - Every return is redacted and bounded.
  - Cancellation, the slots and the off-loop search keep loop affinity.
  - Search inherits the read tools' filesystem rules.
  - Rethrowing an unexpected failure after saving its classification is the right call.
- **L-1 (low), fixed in `1472a70`.** The unverified-cleanup branch had no test, though P2.3a's outside-writer command reaches it natively. `ToolRuntimeNativeTests` now runs that command through `Execute`. The row is unknown with cleanup unverified, and the mutation that completed it now fails.
- **I-1, resolved.** The bullet about regenerating these vectors when #35 and #39 merged was stale; `c4459e5` did that.
- **I-2 to I-4** are recorded below, under Open.
- **A correction to the record.** The first main merge (`5730c1d`) brought in main at `891cf73` (#43), which includes #35, #39 and #42; it was not `e482b03`.

**Open, for later slices.**
- **Worktree confinement (security I5 of P2.3b), decided at P2.3f.** Rudy chose to confine the coding tools to the task's own app-owned worktree; see the P2.3f entry for the decision, its evidence and the check.
- **Rethrown failures (review I-2), resolved in P2.3e.** An unexpected failure now stops the turn as failed. No reservation is open while tools run, the task is not left running, and the runtime keeps serving. TypeScript hands the model the failure's message instead; see the P2.3e entry.
- **Commands too long to launch (review I-3).** A `run_command` longer than about 12,200 characters can be proposed and approved, then fails at launch as "none", because its `-EncodedCommand` line exceeds the 32,767-character command line. TypeScript's helper has the same limit. A preparation-time length check would spare the user an approval that cannot run.

### Project channel (P2.3d)

**What it is.** With `FOUNDRY_RUNTIME_P2_CHAT=1`, the development runtime now serves `channel.get` and `channel.send`, bringing it to **40** of the 89 methods, and sends `channel.changed`. `AgentChannel` is `agent-channel.ts` line for line:
- **No schema change.** Messages are `channel.message` events and model deliveries `channel.received` events. An index rebuilt from those events answers pages; after its first scan it reads only new sequences.
- **Project.** A task's project is the SHA-256 of its lowercased Git common directory, the key TypeScript stores in every message.
  - **Bound tasks.** The identity is the one bound at trusted admission: the first complete `channel.identity` binding, or the root's for a coordinated child. The project folder must still be the approved one, and its current identity must equal the binding exactly.
  - **Legacy tasks** (no binding) keep access only from a plain repository.
- **Participants.** The project's tasks, in `localeCompare` order of their ids, 50 at a time. A task whose channel cannot be resolved is left out. Titles are redacted, and availability is reported: retired, cancelled and fenced coordinated tasks are listed but unavailable.
- **Sends.**
  - A send is idempotent by its request id for one sender and actor. Reusing the id with different content is refused.
  - The sender must be available, and running when it is an agent; a recipient must be another available task of the same project.
  - Each task may send at most 1,000 messages. The text is trimmed, at most 2,048 characters and 2,048 UTF-8 bytes, and screened for secrets.
  - The message and its event commit together, and `channel.changed` is recorded after, as `service.ts` publishes it.
- **Pages.** At most 20 messages and 64 KiB of message JSON, forward from a cursor or backward before one. A task sees broadcasts and its own direct messages.
- **Tools.** `ToolRuntime` owns the channel, as TypeScript's does, and runs `list_project_agents`, `send_agent_message` and `read_agent_messages` for any Git task, chat tasks included. The arguments are screened, then parsed as zod parses them.
- **Model context, for the native tool loop (P2.3e).** `Enrich` adds the task's unacknowledged messages as one bounded `PROJECT_CHANNEL_DATA` user message after the system messages. It stays within a quarter of the profile's context, between 3 and 8 KiB of UTF-8. A first message too large on its own is cut at a code point and marked. Nothing counts as delivered until `Acknowledge` records the cursor.
- **Definitions.** `ToolDefinitions` carries `CHANNEL_TOOL_DEFINITIONS` and `CHANNEL_SYSTEM` byte for byte. Its zod port now builds each field from rules (uuid, nullable, optional, trim and the UTF-8 byte refinement); the 269 argument vectors of P2.3c are unchanged.

**Differences, all fail-closed or invisible on success:**
- **Alias refusal.** A project reached through a junction or symbolic link is not resolved: its task is not listed, and its reads and sends are refused. TypeScript follows the alias to the same identity and shares the channel.
- **Legacy fallback by file identity.** An unbound task's Git and common directories are compared with the root's `.git` by file identity, not by lowercased paths, which in a case-sensitive directory could treat two folders as one.
- **Coordinated children** are fenced from the channel ("This agent is cancelled, fenced or finished."), as TypeScript fences one without an orchestration binding. Native has no orchestration.
- **A missing recipient or task** is refused with TypeScript's "Task not found." rather than faulting the runtime.
- **The index** (review M1, L1 and L2, fixed in `779b690`):
  - **Committed rows only.** It reads only committed rows: while a transaction is open it waits, so a message that an enclosing transaction later rolls back never enters it. TypeScript's index would keep that sequence and then fail on it.
  - **No sends inside a transaction.** Inside a transaction the index is therefore not current, so a send there would not enforce idempotency or the message limit. `Send` refuses to run inside one (re-review condition, `461c5c4`); no caller does.
  - **Unreadable rows.** A row with malformed JSON or a mistyped field is passed over, so one damaged row never stops the channel. The checked fields include the request id, which must be absent or text, as TypeScript writes it; a nested one would overflow the stack when serialized into the index's key. TypeScript's index fails on malformed JSON, and files a message without a project under no project.
  - **Batches.** It reads the history 2,000 rows at a time along the primary key's range, where TypeScript streams it.
- **Alias-refused history.** A task refused as an alias keeps its stored messages, but cannot read them after adoption.

**Evidence.**
- **The oracle.** `tests/p2/agent-channel.test.ts` drives the shipping `RuntimeService`, its `ToolRuntime` and its channel over a disposable tree of Git metadata folders. The tree holds a plain repository with a subfolder, a second project, a linked worktree through `gitdir` and `commondir` pointers, and a folder without a repository.
  - **Seeds.** Tasks cover every binding and availability state: bound, legacy plain and legacy linked, an incomplete binding, a first incomplete then complete binding, retired, cancelled, a coordinated child (in the project and in the linked worktree), chat, folder, a task created after every message, and a secret-bearing title.
  - **Planted row.** A message row written outside `send`, with a raw secret-like title and content, shows that pages redact both.
  - **Cases.** Four: discovery, sends, reads and context (71 steps), message pages, participant pages, and the 1,000-message limit. Each step records its value or refusal and every event row it adds.
  - **Cleaning.** Paths and timestamps become placeholders. Only the project keys TypeScript's formula gives for the fixture's common directories become `{project:a}` and `{project:b}`, so a key computed any other way fails.
  - **Binding.** The vectors are bound to the SHA-256 of `agent-channel.ts`, `channel-tools.ts`, the protocol's `agent-channel.ts` and `limits.ts`, `tool-runtime.ts`, `repository.ts`, `redaction.ts`, `store.ts` and `service.ts`. Regenerating them requires `P2_WRITE_AGENT_CHANNEL=1`.
- **The replay.** `AgentChannelTests` replays every step through `DevelopmentChat`, its `ToolRuntime` and its channel, with the definitions and system text byte for byte. A native-only test pins the alias refusal.
- **Process differential.** The real Node/C# stdio differential now also calls `channel.get` and `channel.send` across the RPC boundary: a projectless chat's refusals, an oversized message, and a missing task.
- **Native tests for the review fixes.**
  - **Unreadable rows:** twelve, nine messages (among them a request id nested 100,000 deep) and three receipts.
  - **Transactions:** a channel read inside a transaction whose message then rolls back, and the refusal of a send there.
  - **Batches:** 4,500 retained messages indexed across batches, with a read across the first batch boundary returning each message once, early and late replays, and the limit count.
- **Mutations.** 40 native mutations; 38 fail the replay. The six added for the review fixes all fail; the unchecked nested request id fails by overflowing the test process's stack, as it would the runtime's.
  - **First run.** It found three gaps, now closed: the inbox leaving out an agent's own broadcast, pages redacting a stored sender title, and zod's uuid versions and variants. One more mutation did not build and was rewritten.
  - **Two survive by design.** The idle-agent check inside `send` is one: the tool path refuses an idle agent first, in TypeScript too. The other is counting the context cut in UTF-16 units: completing a surrogate pair always costs less than a lone half, so the cut lands in the same place here.
  - **Evidence** is in `foundry-evidence\p2.3-d\mutations`.

**Validation.**
- **`59b9f34`** (run1, from a `git archive` export): native 7,236 passed, 0 failed, 2 expected skips; `pnpm check` 582 passed; the stdio differential passed; `git diff --check` clean.
- **`8afdb6f`** (run2, after the review fixes): native 7,239 passed, 0 failed, 2 expected skips; `pnpm check` 582 passed; the stdio differential passed.
- **`461c5c4`** (run3, after the re-review fixes): native 7,239 passed, 0 failed, 2 expected skips; `pnpm check` 582 passed; the stdio differential passed; `git diff --check` clean.

**Independent reviews of `c9ab458..f6f3d0d`.**
- **Security** (`cloud-security-vulnerability-expert`, Opus at high effort): **GO**, with no critical, high or medium finding.
  - **What it ran:** it verified the seal, built an export, ran four replay classes (33 passed), and compared the code line by line with TypeScript.
  - **Confirmed:**
    - a task reads, lists and sends only within its own project, and sees only broadcasts and its own direct messages;
    - the key is TypeScript's formula, so messages written before adoption stay visible;
    - binding fails closed on every branch;
    - every untrusted value is redacted on the way out;
    - no model-reachable input faults the runtime.
  - **I-3** (a malformed row breaks the index) is fixed with data L1.
  - **I-1, I-2 and I-4** are recorded below, under Open.
- **Data integrity** (`db-steward`, Sonnet at high effort): **GO with conditions**, with no critical or high finding.
  - **Seal and suite:** it verified the seal, built an export, and ran the replay and the TypeScript oracle.
  - **Probes against both runtimes:**
    - rows are byte-compatible in both directions;
    - each runtime reads the other's messages, request ids and delivery cursors;
    - a 30-page differential, with the 64 KiB cap binding, was identical;
    - a restart rebuilds the same pages, replays and cursors.
  - **M1 (medium), L1 and L2 (low):** fixed in `779b690`, as the index entry under Differences describes. M1 was a condition before P2.3e.
  - **L3 (evidence gaps):** the rollback, corrupt-row and batch gaps are now pinned. A restart rescan and a coordinated child sender's `root_task_id` remain probe-verified only.
  - **Re-review of `f6f3d0d..8afdb6f`: GO with conditions.**
    - **Confirmed fixed:** M1, L1 and the memory half of L2.
    - **Batch progress** is correct across 23 boundary layouts, among them exactly 2,000 rows, batches ending on other events, deleted rows and later appends.
    - **Conditions, all closed in `461c5c4`:**
      - validate the request id, since a tampered nested one overflowed the stack;
      - refuse a send inside a transaction;
      - correct these notes.
    - **Optional, also applied:** the scan reads along the primary key instead of sorting each batch.
  - **Confirmation of `8afdb6f..e3bc05f`: GO, with no conditions remaining.**
    - It confirmed each condition closed and found nothing new.
    - It re-ran its boundary probe on 24 layouts with the primary-key scan; all were correct.
    - The first read of 200,000 rows now takes 3.96 s.

**Open, for later slices.**
- **Wiring, done in P2.3e.** `Enrich` and `Acknowledge` are wired by the native tool loop, `Acknowledge` in the response transaction as TypeScript wires it. With M1 fixed, the index never takes a row from that transaction before it commits.
- **Participants cost** (security I-1, data L2). The prefilter below landed in P2.3e, for tasks bound to other projects; see that entry for what remains.
  - **The cost:** each participants page reads every task and admits each one's folder and Git identity on the loop, as TypeScript does. The data review measured 151 ms for 100 tasks and 4.7 s for 2,000.
  - **Fix:** load the first binding of every task once, and admit only the candidates whose bound or stored common directory can equal the caller's.
- **A lowercased key is a shared limit (security I-2).** Two repositories whose paths differ only in case, inside a case-sensitive folder, share one project key in both runtimes. Changing the key would hide messages written before adoption.
- **Refusal text (security I-4).** Refusals tell a missing task from one in another project, as TypeScript's do. The texts are fixed strings, and ids come only from the caller's own participants.

### Agent loop and Git-project chats (P2.3e)

**What it is.** The development runtime's `task.start`, `task.send` and `task.cancel` now serve chats in Git projects. The method count is unchanged at 40. `AgentLoop` ports `agent-loop.ts`'s `prepareRequest` and `run` for the chats native serves:
- **Requests.** A projectless or folder chat advertises nothing, as before. A Git chat advertises the project channel's three tools and leads a fresh history with the chat instruction and `CHANNEL_SYSTEM`. Every request it makes carries its unacknowledged channel messages (`Enrich`). A stored conversation resumes with its continuation and its calls' results; an interrupted call gets the explicit "not replayed" error.
- **Iterations.** Up to 51 provider responses, each with at most 16 calls with distinct, non-empty ids, and at most 50 tool calls in the turn.
  - **Responses.** A tooling response must carry its provider's continuation, within 512 KiB. The continuation and the calls must be free of secret-like data. No call may reuse an id the task has used, and the task keeps at most 1,000.
  - **Persistence.** The provider state, the channel acknowledgment (`Acknowledge`), the answer and the request's settlement commit together. The state is saved again after each tool result, with a `task.tool-result` event, now also a notification.
  - **Further requests.** An unknown mutation outcome after a tool stops the turn. Each further request is enriched and admitted against the task's budget. The context warning is published once per turn and the budget warning on each admission.
- **Git starts** follow `startTask`:
  1. The project is checked and classified as before. For a Git project, the channel identity is resolved, and that admission is held until the binding commits.
  2. Coordination settings, the coordinated mode, the profile and any unknown worktree creation are checked; then coding is refused (below).
  3. The start is reserved, and a `worktree.create` intent, with the request id, is written before any Git mutation. The task, its channel binding and the completed intent commit together, and the first turn starts.
  4. A failure leaves the intent complete, and forgets the start, only when the repository reported that nothing started; the repository's refusal then reaches the caller with TypeScript's text. A first turn that could not start leaves the start failed. A retry re-checks the project and re-admits the channel.

  `task.create` now binds through the same `AgentChannel.Admit`.
- **Turns.** A Git chat's turn is refused while a commit, push or reconciliation runs ("Wait for the Git operation to finish before starting a response.", now also passed to RPC callers), and as retired while its worktree retires, as `startTurn` refuses them.
- **The offline provider** gains three stages, with call ids from the runtime's id source:
  - the channel demo: `/channel-demo` makes one `send_agent_message` call;
  - its result stage;
  - the stopped browser demo: `/browser-demo` without browser tools.
- **Participants** (security I-1 and data L2 of P2.3d). Every task's first binding is loaded once, and a task bound to another project is passed over without admitting its folder. So is a task whose binding row does not parse, which `Project` would refuse. Unbound Git tasks and tasks bound to the same project are still admitted one by one. A page lists the tasks TypeScript's lists, including when a binding row cannot be read (below).
- **Binding rows** are read as TypeScript reads them (review fixes, `e08ae79`):
  - **The first complete row decides.** Its identity is the binding, absent when the row is not an object or the identity is missing or null.
  - **Identities that are not objects.** A truthy one never matches, so its task is refused; a falsy one (0, false, "") is unbound. Before this, native treated any identity that is not an object as unbound (security I-4).
  - **Unreadable rows.** A row that does not parse refuses only its own task, and a row SQLite cannot read refuses only the tasks whose lookup scans past it. A page leaves out exactly those tasks, and the runtime keeps serving. Before the fix, one such row made every participants page fail, and `channel.get` ended the runtime (security L-1, data L1).

**Differences, all fail-closed or invisible on success:**
- **Coding and coordinated tasks.**
  - **Coding mode.** `task.start` refuses it ("Coding turns need native approvals, which a later runtime slice wires.") after TypeScript's checks and before any reservation or worktree.
  - **Coordinated mode.** `task.start` refuses it ("Coordinated tasks are not available in this build.") where TypeScript checks it.
  - **Turns.** `task.send` refuses a coding task's turn, and both methods refuse coordinated roles, before any reservation.

  P2.3f serves coding turns.
- **Stored continuations.** A turn is refused before any reservation unless its stored continuation is in a stage the offline provider serves natively: `chat`, `complete` or `channel-send`. The coding, MCP, browser and orchestration demos' stages need their slices.
- **Unclassified tool failures** (P2.3c review I-2). A failure the tool runtime does not classify as a refusal stops the turn as failed, with its redacted message. TypeScript hands the model the message and continues. No reservation is open while tools run, and the runtime keeps serving.
- **No browser host.** No turn has attached tabs, and the browser demo always stops. TypeScript asks its host before each `task.send`.
- **Unreadable binding rows** are refused with "Project channel binding is unreadable." TypeScript reports its JSON reader's or SQLite's own error. SQLite reads JSON5 that the strict JSON reader refuses.
- **An unknown start outcome over RPC.** "Chat creation has an unknown outcome. Inspect the saved chat and retained intent before retrying." carries the failure's detail in TypeScript. Over RPC, native reports "Runtime request failed." instead, as it has for projectless and folder chats since P2.2f (data review I2).
- **Iteration limit.** As in TypeScript, the 51-response limit cannot be reached: 51 responses with calls exceed the 50-call limit first.

**A correction the provider port makes.** TypeScript's offline provider answers `/browser-demo` (after trimming) in every chat, projectless and folder chats included: "Offline browser demo stopped…" instead of "Fake response: /browser-demo". The native provider gave the latter until this slice; no earlier vector sent that text.

**Evidence.**
- **The provider oracle.** `tests/p2/fake-tools.test.ts` streams 33 inputs through the shipping offline provider. `FakeToolTests` replays each one. The vectors are bound to the provider sources. The inputs cover:
  - the channel demo with and without tools;
  - JavaScript trimming: U+3000 and U+FEFF trimmed, U+0085 kept;
  - later and earlier user messages, and stored and invalid continuations;
  - result stages with matching, mismatched, missing and erroring results;
  - cancellation and the browser demo.
- **The Git-chat oracle.** `tests/p2/git-chat.test.ts` drives the shipping `RuntimeService` over a disposable repository, with deterministic identities and a fixed clock, through five cases (103 steps):
  - **the channel:**
    - two Git chats and the channel demo;
    - the second chat's first request carrying the broadcast and acknowledging it;
    - an oversized message refused, and the browser demo;
    - cancel of an idle chat;
    - retirement and the refused turn after it;
    - an overlapping send, made in one step so that it never depends on timing (data L2), and a missing task;
  - **failed starts:**
    - a start refused by its budget after its worktree is made, and two retries;
    - a hidden project, coordination settings and a missing profile;
    - an unknown worktree creation;
  - **worktree creation failures** (data M1): a repository with no commit, whose start is forgotten, re-run and, after a commit, served; and a task branch that already exists, which leaves the intent and the start unknown and blocks the next start;
  - **coding**, the named difference;
  - **the loop's limits**, with a scripted provider:
    - two and three iterations;
    - duplicate, seventeen, reused and empty call ids;
    - a missing and a foreign continuation, secret-bearing continuations and calls, and a continuation over 512 KiB;
    - data after completion, and no completion;
    - six tool refusals the model sees;
    - the output and transcript limits, and the context warning;
    - the 50-tool limit, and the recovery of its unfinished call;
    - the 1,000-id history;
    - a refused second admission, and the budget warning on a continuation;
    - an unknown mutation outcome.

  Each step records its value or refusal, the rows it added, changed or removed in seven tables, its notifications, and every request a provider received. Paths and the fixture's project key are placeholders. The vectors are bound to twelve runtime and provider sources; regenerating them requires `P2_WRITE_GIT_CHAT=1`.
- **The replay.** `GitChatTests` replays every step through `DevelopmentChat` with the same identities, clock, offline provider and scripts, and reproduces every record byte for byte. The coding step must be refused with nothing changed.
- **Folder chats.** The P2.2f oracle's Git-project step is now served. Its named difference is removed, a wait is added, and `FolderChatTests` reproduces both steps.
- **The channel oracle** (`tests/p2/agent-channel.test.ts`, P2.3d) gains a fifth case of unusual binding rows: JSON5, not JSON, a string, zero, an array and no identity, a child of a task whose binding does not parse, and a task bound after an unreadable row. It pins the pages and refusals both runtimes give alike.
- **Native-only tests** (`GitChatNativeTests`):
  - a cancellation between iterations;
  - a chat without tools refusing a provider's tool call (security I-1);
  - an unclassified tool failure (I-2);
  - a coordinated start refused before any intent;
  - turns refused during a commit and during a retirement;
  - stored continuations: a coding stage refused, and an interrupted channel demo resumed with the "not replayed" result.

  `AgentChannelTests` pins the participants prefilter by counting admissions, a task whose first and latest bindings differ, and the refusal of unreadable binding rows through `channel.get` with the runtime still serving.
- **Process differential.** The stdio differential now also runs a Git-project chat through both entry points, with an isolated Git configuration: a worktree-backed start, the channel demo, a second chat reached by its broadcast, the channel page, a repository with no commit and its refusal's text, and native's coding refusal.
- **Mutations,** in `foundry-evidence\p2.3-e\mutations`:
  - **First run (`db4a117`):** 51 mutations. 43 were caught, 6 survived, and 2 did not build.
  - **Two survivors are by design.** The 52-response limit, which cannot be reached. The failed-start retry's channel check, which the turn's enrichment repeats with the same refusal.
  - **The other four survivors were test gaps, now closed:** a chat without tools accepting a tool call, a refused worktree keeping its start reserved, the prefilter taking a task's latest binding, and the result stage reading the last call.
  - **Second run (`e08ae79`):** 18 mutations: the four test-gap survivors, the two that did not build (now rewritten so they do), seven for the review fixes and five rechecks. 17 fail.
    - The survivor is equivalent: passing over a binding row that does not parse is also what the next check does with any binding that is not an object.

**Validation.**
- **`db4a117`** (run1, from a `git archive` export): native 7,284 passed, 0 failed, 2 expected skips; `pnpm check` 584 passed; `git diff --check` clean. The stdio differential passed in the worktree.
- **`9e93406`** (run2, from a `git archive` export, after the review fixes): native 7,288 passed, 0 failed, 2 expected skips; `pnpm check` 584 passed; `git diff --check` clean. The stdio differential's two cases passed in the worktree at the same commit.

**Independent reviews of `2120abf..ca41410` and `ca41410..a4dc6c0`.**
- **Security** (`cloud-security-vulnerability-expert`, Opus at high effort): **GO with conditions**, with no critical, high or medium finding.
  - **What it ran:** it verified both seals, built an export, ran seven classes (92 passed) and three TypeScript oracles, and wrote one probe.
  - **Confirmed:**
    - a chat task can run only the channel tools;
    - coding and coordinated tasks are refused before any reservation, intent or worktree;
    - every provider-output check precedes persistence and execution, in TypeScript's order;
    - `Enrich` and `Acknowledge` match TypeScript;
    - the Git start holds its admission through the binding;
    - the checks against Git operations leave no window on the loop.
  - **L-1 (low), fixed in `e08ae79`:** an unreadable binding row, as above.
  - **I-1, fixed:** no test pinned a chat without tools refusing a tool call.
  - **I-4, fixed:** identities that are not objects.
  - **I-2 and I-3:** the worktree was mid-mutation while it worked, and validation is to be recorded at the final commit. Both are addressed below.
- **Data integrity** (`db-steward`, Sonnet at high effort): **GO with conditions**, with no critical, high or data-corrupting finding.
  - **What it ran:** it verified both seals and ran the classes, the oracle and the full conformance project (7,084 passed).
  - **Probes:** it compared rows written and read by both runtimes, in scratch databases.
    - Git chats resumed across runtimes, complete and interrupted at `channel-send`, left identical rows.
    - Cancellation, provider failure and shutdown in each response settled every reservation once and left no task running.
    - Both Git-start failure branches matched TypeScript.
    - A 22-task prefilter seed gave the unfiltered page.
  - **M1 (medium, evidence), fixed:** the Git-start failure branches had no test. The oracle now pins both.
  - **L1 (low), fixed:** a binding row that is not JSON made every page fail; the same fix as security L-1.
  - **L2 (low), fixed:** the overlapping send depended on timing natively under load.
  - **I1:** the 1 MiB edit it saw was a mutation in flight, not a change; the worktree is clean.
  - **I2:** a Git start's repository refusal reached RPC callers as "Runtime request failed."; it now carries TypeScript's text. The unknown-outcome message stays masked, as recorded under Differences.
  - **I3, recorded:** `Store.IsGitDocument` does not treat an empty `workspaceKind` as Git, as TypeScript does. TypeScript never writes one, and `RequireChat` refuses such a task before any request.
  - **I4, parity:** a response transaction that fails at commit leaves its request pending until recovery marks it interrupted, as in TypeScript.
- **Re-reviews of `a4dc6c0..e08ae79` and `e08ae79..9e93406`: both GO, with no conditions remaining.**
  - **Security:** it confirmed L-1, I-1 and I-4 fixed and found nothing new. It verified both seals and ran five classes (60 passed) and three oracles. Its probes found that an identity of `1e400` or a lone surrogate escape leaves `channel.get` serving.
  - **Data integrity:** it confirmed M1, L1, L2 and I2 fixed and found nothing above informational. It verified both seals and ran five classes (52 passed) and two oracles.
    - Its Git-start probes match TypeScript in both branches.
    - Its 22-task prefilter seed still gives the unfiltered page. Three tasks with identities that are not objects now leave it, as in TypeScript.

**Open, for later slices.**
- **P2.3f, done:** coding turns with approvals, and `approval.decide`, with Rudy's worktree-confinement decision; see that entry.
- **Participants cost, remaining.** A page still admits every unbound Git task and every task of the caller's own project, one by one, as TypeScript does. The data review measured 117 admissions and 327 ms for 722 tasks, 600 of them bound elsewhere.
- **External profiles** still refuse every turn. The loop reads no usage or metadata events, which only external providers produce.

### Coding turns and approval decisions (P2.3f)

**Decision I5, recorded 18 October 2026.** Asked whether native should confine the model-driven coding tools to the task's own app-owned worktree, Rudy chose "Confine tools (Recommended)".
- **What it means.** The six coding tools and their approvals run only when the stored worktree is exactly `<data>\wt\<task id>`. File views, `task.diff` and commit, push, reconcile and retire keep TypeScript's behaviour.
- **Its evidence.** Since the foundation commit (`6bbaef8`, 16 September 2026), TypeScript has kept its data in `%LOCALAPPDATA%\FoundryAgentWorkspace`; only unpackaged builds may override that, for tests. It has created every task worktree at `<data>\wt\<task id>`, and coordinated children at `wt\children\<task id>`. All six fixture eras store exactly those paths. Only a hand-edited row or a copied data folder can name another.
- **The check, after the security review (`7512036`).** The stored worktree and the task's own folder are compared as folders, by volume and file identity at every level, and neither path may pass through a reparse point. Another spelling of the task's own folder (case or 8.3) is served. A different folder whose name only case-folds alike (the Kelvin sign folds to k, which NTFS keeps apart), or any path through a junctioned worktree folder, is refused. The first version compared lowercased spellings, which let both through (security L-1).

**What it is.** With `FOUNDRY_RUNTIME_P2_CHAT=1`, the development runtime serves coding tasks in Git projects and `approval.decide`, bringing it to **41** of the 89 methods.
- **Requests.** A coding task's turn advertises the six repository tools before the channel's three, under TypeScript's coding instruction and `CHANNEL_SYSTEM`. External (MCP) and browser tools are never advertised.
- **Starts and turns.** `task.start` creates a coding task as it creates a Git chat (P2.3e), and `task.send` turns it.
- **Approvals.** Edits and commands are proposed, saved and held until the user's one-shot decision through `approval.decide`, then executed as P2.3c ported them. A cancelled turn revokes its waiting proposal. A decision with another nonce, from another task, or for a missing approval is refused.
- **The offline provider** gains the coding demo on a task's first turn: `/demo` reads `README.md`, proposes appending a line, then proposes `Write-Output 'Foundry command demo completed'`. Its stored stages (read, replace and command) now resume natively; the MCP, browser and orchestration demos' stages are still refused.
- **Commands** inherit the runtime's environment, which tests now supply to commands as they do to Git.

**Differences, all fail-closed or invisible on success:**
- **Confinement (decision I5).** Before any argument check, read, proposal or execution, a coding tool requires the stored worktree to be the task's own app-owned folder, compared by identity as above. Otherwise the model is told "This task's worktree is not its app-owned worktree, so coding tools are refused." TypeScript uses the stored path.
- **External tools (decision 2).** A coding start or turn is refused before any reservation while an enabled MCP server has stored tools, or a server row that does not parse: "Coding turns cannot use external MCP tools yet. Disable the MCP servers that list tools before starting a coding turn." TypeScript advertises those tools.
- **Compare-and-set (P2.3b's carried item).** The saves the tool runtime makes from its own copy of an approval require the stored state that copy last saw: revoked while waiting, executing, the final state, and a failure's outcome once a decision is known. The one exception is a failure's outcome while the proposal still waits, which only a failure other than a conflict can reach. `Decide`, `RevokeWaiting` and `Reconcile` read the row afresh. On one loop no such change can interleave today; the check keeps a later writer from silently undoing a decision.
  - **Before the executing state** nothing has run: a changed row stands, and the stale copy writes nothing more ("The approval changed while it was in use; it was not overwritten.").
  - **After it** the action may have run: the outcome is recorded unknown over the change ("The approval changed while its action ran, so its outcome is unknown."), so the next turn waits for reconciliation.
  - **The first version** let the failure path save the stale copy after a conflict, and left an executed action unrecorded (security L-2, data L1 and L2); both are fixed in `7512036`.
- **The reviewed proposal is the one that runs.** A decision applies only while the stored proposal, which `approval.get` shows the user, is the copy that would execute; otherwise it is refused as stale (security I-1, `7512036`).
- **Coordinated tasks** remain refused before any reservation.

**Evidence.**
- **The Git-chat oracle** (P2.3e) now serves its coding case, and gains two cases on the real clock. TypeScript's command helper checks its parent's start time, which a faked clock breaks. Timestamps become `{time}`, and progress notifications, whose count depends on timing, are left out.
  - **The coding demo, approved:** the read, the approved edit and command, the approvals page, `files.read`, `task.diff`, and `/demo` again on a later turn, which runs no demo.
  - **Rejected, cancelled, resumed and decided stale:**
    - a rejected edit;
    - a cancellation while waiting, which revokes, and the next turn resuming from the stored replace stage;
    - a stale nonce, another task's decision and a missing approval, each refused;
    - an approved edit and a rejected command.

  A coding step is recorded once its task stops running or proposes a new approval, which both runtimes reach alike. The shell, SystemRoot and approval fingerprints become placeholders, as in the P2.3c oracle. TypeScript's command helper draws a result nonce that nothing records and native has no use for (P2.3a); the oracle gives that one draw a real UUID, so the identities after a command match.
- **The provider oracle** gains 30 coding-demo inputs: advertised tools, result matching, unreadable and incomplete read results, and JavaScript's own errors for a missing result. `FakeToolTests` replays all 63.
- **The tool-runtime oracle** (P2.3c) places its fixture worktrees where the product puts them: task 1's at `data\wt\<id>`, with a copy for task 5. Every outcome is unchanged; only paths differ.
- **Native-only tests:**
  - **confinement:** four foreign worktrees refused for each of the five tools, and a spelling that differs only in case served; the identity check itself against a Kelvin-sign sibling and a junctioned worktree folder;
  - **the compare-and-set:** a row revoked between the decision and the resumed call, a row changed while its proposal waits and then cancelled, and a row changed while the action ran, recorded unknown;
  - **a decision on a proposal changed since it was saved,** refused, with nothing run;
  - **decision 2:** disabled and empty servers ignored, listed and unreadable servers refusing coding starts, turns and a failed start's retry with nothing written, and chats unaffected;
  - **a coding task outside Git,** refused with its reason.
- **Process differential.** The stdio differential now also runs the coding demo through `task.start`, `task.approvals`, `approval.get` and `approval.decide` in both entry points, including a stale decision. Approval fingerprints are normalized.
- **Mutations,** in `foundry-evidence\p2.3-f\mutations`:
  - **First run (`ddc6636`):** 29 mutations. 26 were caught, 2 survived and 1 did not build.
  - **The two survivors were test gaps:** the final save without its expected state, and the refusal of a coding task outside Git (a later layer refused it with another message). Both are pinned since `7512036`. The one that did not build is rewritten.
  - **Second run (`7512036`):** 13 mutations, for the review fixes and the earlier gaps. 11 were caught and 2 did not build; both were rewritten, and a third run caught both.

**Validation.**
- **`ddc6636`** (run1, from a `git archive` export): native 7,323 passed, 0 failed, 2 expected skips; `pnpm check` 584 passed; `git diff --check` clean. The stdio differential passed in the worktree.
- **`7512036`** (run2, from a `git archive` export, after the review fixes): native 7,329 passed, 0 failed, 2 expected skips; `pnpm check` 584 passed; `git diff --check` clean. The data reviewer's export of `6245bb0` ran the stdio differential after the fixes; it passed.
- **`b8b55c2`** (run3, from a `git archive` export, after merging main at `6ed63d6` as `2235d5f`): native 7,330 passed, 0 failed, 2 expected skips; `pnpm check` 587 passed; the stdio differential passed (2 of 2) in the same export; `git diff --check` clean against main.
  - **What main brought in.**
    - #44 (F1) changed `repository.ts`. The four oracles bound to it (agent channel, approvals, Git chats and tool runtime) were regenerated, and only that source hash changed (`b8b55c2`).
    - #45 changed `git-operations.ts`, which no P2 vector binds.
    - #40 added `preparation/cli-drivers`, which sits outside `Foundry.slnx`.
  - **The one conflict** was in this file. This branch's record of L1's native half replaced main's one-line pointer to it, and main's index-lock entry was kept.
- **CI's first run of the stack (#46) failed: the tests' scratch profiles, not the runtimes.**
  - **What failed:**
    - natively, the coding demo's replay, and two outside-writer tests;
    - in TypeScript, the Git-chat oracle.
  - **What the failures had in common.** Every executed command that failed called a cmdlet without naming its module:
    - the offline demo's `Write-Output`, which both runtimes run with its 10-second limit;
    - the two native tests' `Add-Type`;
    - the TypeScript helper `job-runner.ps1`'s `Add-Type`, which runs for every command.

    The commands that used only .NET calls passed.
  - **The cause,** inferred from that pattern, local probes and the image's module list. The rerun with the fix on CI is what confirms it. Windows PowerShell 5.1 finds an unqualified cmdlet through its module analysis cache, which it keeps in the profile's local application data.
    - The tests give each command a fresh scratch `USERPROFILE`, which has no cache, so every start analyses every installed module first.
    - Here that costs about 0.15 seconds. The `windows-2025-vs2026` image also has AWSPowerShell, Microsoft.Graph, SqlServer and Az installed, so there it took 10 to 60 seconds:
      - the demo timed out;
      - the outside-writer test exceeded its 30-second bound;
      - the unverified-cleanup command hit its 60-second limit.
    - Production runs commands under the user's own profile, so this was a property of the tests' environment, not of either runtime.
  - **The fix, test-only.**
    - `PowerShellModuleCache.cs` and `tests/p2/powershell-module-cache.ts` warm the cache once under their own scratch profile and copy it into every fixture's profile, as a real profile would have it. The shared copy is `%TEMP%\foundry-p2-powershell-module-cache`.
    - PowerShell still reports the same first-use progress, so nothing a command prints changes, and no vector changed.
    - The two native-only `Add-Type` calls are module-qualified (`Microsoft.PowerShell.Utility\Add-Type`). They run under the real profile, and qualifying the call skips the analysis.

**Independent reviews of `7d01f30..ddc6636` and `ddc6636..4466b4f`.**
- **Security** (`cloud-security-vulnerability-expert`, Opus at high effort): **GO with conditions**, with no critical, high or medium finding.
  - **What it ran:** it verified both seals, built an export, ran six classes (107 passed) and three TypeScript oracles, and wrote probes.
  - **Confirmed:**
    - nothing in model output, repository text or stored state grants execution;
    - an edit or command runs only after the one-shot decision on exactly the prepared action;
    - stale, cross-task, missing, coordinated and repeated decisions are refused;
    - restart recovery revokes waiting and approved rows, and nothing replays;
    - decision 2 gates every path to a coding turn before any reservation;
    - the coding instruction is byte-identical, and the demo matches TypeScript;
    - production passes no test environment to commands.
  - **L-1 and L-2 (low), fixed in `7512036`,** as above: spellings that case-fold alike or a junctioned base passed confinement, and a stale copy saved after a conflict.
  - **I-1, adopted:** the reviewed proposal must be the one that runs.
  - **I-3, pinned:** decision 2 on a failed start's retry.
  - **Recorded, not changed:**
    - **I-2:** `Reconcile` reads the stored worktree, within Rudy's choice to leave everything but the coding tools unconfined.
    - **I-4:** a malformed MCP row whose failure is not a JSON or cast error refuses with a generic error, still before any reservation.
    - **I-5:** `RevokeWaiting` has no caller yet; scoped cancellation in later slices uses it.
- **Data integrity** (`db-steward`, Sonnet at high effort): **GO with conditions**, with no critical or high finding.
  - **What it ran:** it verified both seals and ran the classes, the oracles and the stdio differential.
  - **Its cross-runtime probes:**
    - a writer stopped while a command proposal waited, resumed by either runtime: identical rows and responses in all four combinations;
    - rows rewritten to executing or approved before reopening: identical recovery and reconciliation;
    - provider state dropped on tasks of either runtime, and a graceful shutdown while a proposal waited: identical rows.
  - **L1 and L2 (low), fixed:** the stale save after a conflict, and an executed action left unrecorded after one.
  - **L3, fixed:** the entry overstated the compare-and-set, and two mutations survived; both are corrected and pinned.
  - **Recorded:**
    - `HasBlockingUnknown` scans every task's approvals, as TypeScript does;
    - decision 2's reading of disabled servers with unreadable tools, and of tools whose names cannot be composed, differs from TypeScript's listing, fail-closed;
    - the real-clock cases check timestamps' format, not their values or order.
- **Re-reviews of `4466b4f..7512036` and `7512036..6245bb0`: both GO, with no conditions remaining.**
  - **Security:** it confirmed L-1, L-2 and I-1 fixed and found nothing new. It verified both seals, built an export and ran five classes (49 passed).
  - **Data integrity:** it confirmed its four conditions met and found nothing above informational. It verified both seals, ran five classes (49 passed), two oracles and the stdio differential, and re-ran its cross-runtime probes; they again gave identical rows.
    - **Its own mutations:** of the two earlier survivors, both now fail.
    - **The I-1 check, probed:** proposals holding line and paragraph separators, a lone surrogate, control characters, emoji, backslashes and quotes still round-trip and are decided normally.
  - **Informational, recorded:**
    - **`SameFolder`** catches only I/O errors, so a folder it may not open fails the turn rather than returning the confinement refusal; fail-closed.
    - **A conflict on the failure path's own save** surfaces the conflict instead of the original error; the stored outcome is correct.

**Open, for later slices.**
- **External tools:** decision 2's refusal lifts with the MCP slice.
- **Browser tools, coordinated orchestration and external profiles** remain refused.
- **Confinement covers the coding tools only.** File views, `task.diff` and the Git actions follow TypeScript, as decided.

### P2.4 Azure providers — authority and slices

**Recorded 18 October 2026. Rudy approved the plan and chose the recommended answer to every decision.** His answers:
- slices a–d with decisions 1 and 5: "Approve (Recommended)";
- decision 2: "(B) Fail closed (Recommended)";
- decision 3: "All three (Recommended)";
- decision 4: "No live calls, no seam (Recommended)".

**Scope.** Port the Azure adapter in `packages/providers/src/index.ts` (`AzureProvider`) and the runtime paths that use it. The development runtime (`FOUNDRY_RUNTIME_P2_CHAT=1`) then serves external profiles as TypeScript does:
- **API kinds:** Responses (`/openai/v1/responses`), Chat Completions (`/openai/v1/chat/completions`) and Anthropic (`/anthropic/v1/messages`).
- **Capabilities:** streamed text, tool calls with native continuation, usage and response metadata, effort presets and cancellation.
- **Methods:** `profile.save`, `profile.probe` and the `runtime.credential` frame, bringing the runtime from 41 to **43** of the 89 methods.
- **Where:** external profiles in projectless, folder and Git chats and in coding tasks, behind TypeScript's verification gates.

**What the runtime asks of a provider** (from the code at `33c2ca8`):
- **`streamTurn(request)`.** The request carries the profile, the messages, the credential, an abort signal, the tool definitions (name, description and input schema), the native continuation and the tool results. The adapter yields `text`, `metadata`, `usage`, `tool_call` and `done` (with the continuation).
- **`probe(profile, credential, observer)`.** Four requests, each with a 20-second deadline: text with usage, a cancellation check, a fixture tool call, and its continuation. On schema v4 and later, the runtime's observer records each request as a `probe` usage request.
- **`ProviderHttpError`.** The status and a bounded `Retry-After`. Only the orchestrator reads either.
- **Gates are the runtime's, not the adapter's.**
  - Verification is the runtime fingerprint (`profile-fingerprint.ts`: the raw endpoint plus `credentialRef`). A save keeps it only when the fingerprint is unchanged; a new credential clears it.
  - Tools, including channel tools, need a probe that found tools and continuation.
  - The adapter's own `profileFingerprint` (WHATWG-normalized endpoint) appears only in a probe result, which the runtime overwrites.
- **Native today.**
  - `FakeChatProvider` takes messages, a continuation, tool names (not definitions) and results.
  - `AgentLoop` throws on `usage` and `metadata` events, and settles with no measured usage.
  - `DevelopmentChat.RequireFake` refuses every other profile, and `Program` answers the credential frame as an invalid request.
  - Already in place from P1 and P2: the credential frame's schema, `Compatibility.ProviderProfileFingerprint`, `EcmaUrl.AzureEndpoint`, `Redactor.Add`, `RequestAccounting.MeasuredUsage`, and the Store's usage primitives (`BeginUsage`, `FinishUsage`, `SettleTaskRequest`), which take measured usage and metadata.

**Left out of P2.4:**
- **Coordinated orchestration.** 429 `profile-quota` waits, per-profile slots and `Retry-After` scheduling stay with the orchestrator slice; `ProviderHttpError` carries the fields it needs.
- **MCP and browser tools,** and the orchestration and browser fixtures (their slices).
- **Later slices:** `task.compact`, `task.usage` and `diagnostics.export`.
- **`scripts/qualify-deployments.mjs`** stays a standalone development tool (plan, verification layer 9).
- **The host side:** the DPAPI vault (`Host.DpapiVault`, P3) and any Electron change.

**Slices**, each sealed, reviewed and recorded on its own:
- **a: the adapter's requests and transport, unwired.**
  - **Requests.** Endpoint normalization, and the URL, headers and body for all three kinds: tool and effort mapping, continuation input with its tool results, and Anthropic's merged tool-result block.
  - **Transport.** The rules below; `ProviderHttpError` and `Retry-After`; cancellation before the request is sent and during reads.
  - **The SSE reader.** Decoding, line endings, `event:` and `data:` lines, and the 1 MiB event, 8 MiB stream and 10,000-event caps.
  - **The Chat Completions parser,** which carries the framing evidence.
- **b: the Responses and Anthropic parsers, unwired.**
  - **Responses.** Output items and their cross-check against the completion, refusals and unsupported content.
  - **Anthropic.** Content blocks (text, thinking, signature, tool-use JSON) and stop reasons.
  - **Both.** Usage (with Anthropic's cache buckets), metadata, call validation, and the continuation each kind stores.
  - **Round trips.** A stored continuation and its tool results, fed to slice a's request builder, must give TypeScript's next body byte for byte.
- **c: profiles, credentials and probes.**
  - **`profile.save`:** TypeScript's checks in order, the endpoint rule at save time, verification kept only for an unchanged fingerprint, the credential dropped when the binding changes, and the save generations.
  - **The `runtime.credential` frame:**
    - its schema;
    - the binding, `JSON.stringify([apiKind, endpoint, deployment])`, checked against the stored profile;
    - refusal while any response runs;
    - registration with the redactor;
    - verification cleared, with no event (as in TypeScript);
    - decision 2.
  - **`profile.probe`:**
    - the adapter's four requests, their deadlines and the cancellation check;
    - the probe usage requests;
    - verification saved only if neither the profile nor the credential changed during the probe;
    - one probe per profile at a time;
    - the offline profile's probe.
- **d: external profiles in turns.** `RequireFake` goes.
  - **Gates:** "Probe this model profile successfully before starting a response." and the tools gate, on starts and turns.
  - **Requests:** the stored credential is passed to the adapter. Channel tools are advertised only to a profile verified for tools and continuation. Stored continuations of an external kind resume.
  - **Accounting:** usage and metadata are read from the stream, and measured usage settles with its request (including "Provider reported final usage for an unsuccessful request.").
  - **Failures** are recorded with their redacted messages.

**Transport rules (slice a).** From the plan (section 2) and the Node behaviour measured below. One `SocketsHttpHandler`:
- **Fixed settings:** `AllowAutoRedirect=false`, `UseCookies=false`, no certificate callback, no default credentials, `ResponseHeadersRead`, HTTP/1.1, no automatic decompression.
- **`UseProxy=false`.** TypeScript's fetch ignores the Windows proxy settings and its runtime receives no proxy variables (`supervisor.ts:21-22`), so it connects directly. .NET would otherwise use the system proxy. This is parity, under the freeze.
- **No client timeout.** `HttpClient.Timeout` otherwise defaults to 100 seconds and would cut long streams. As in TypeScript, the turn's 10-minute limit, the probe's 20-second deadlines and cancellation bound each request.
  - **Corrected in P2.4a.** undici bounds fetch as well: 10 seconds to connect and about 300 seconds to receive headers ("fetch failed"), and about 300 seconds without a byte of the body ("terminated"). Native reproduces these bounds; see that entry.
- **Request bytes:** the UTF-8 bytes of `JsJson.Stringify`, sent with `content-type: application/json` exactly (no charset), `accept: text/event-stream` and `api-key`, plus `anthropic-version: 2023-06-01` for Anthropic.
- **Measured.** Electron 44.4.1's Node (24.21.0) was run as Node against a loopback server. Native must give the same outcomes:
  - a redirect status, with or without `Location`, rejects with `TypeError: fetch failed` before any body is read, and so does a refused connection;
  - a 204 is `ok` with no body, so the adapter reports "Provider returned no response stream.";
  - an empty query (`…/responses?`) is sent without its `?`.

**Expected named differences.** Each is pinned by a test and recorded in its slice; all fail closed or are invisible on success.
- **Headers the transport adds.** Node's fetch adds `user-agent: node`, `accept-language: *`, `sec-fetch-mode: cors`, `accept-encoding: gzip, deflate` and `connection: keep-alive`. Native sends the adapter's headers and the framing ones only. Without `accept-encoding`, a server sends the stream uncompressed; both runtimes' 8 MiB caps count decoded bytes.
- **Certificate trust.** Measured: Electron's Node trusts its 121 bundled roots and the 105 roots in this machine's Windows store. Native trusts the Windows store, with Windows' automatic root update. The difference is a bundled root that the Windows store lacks.
- **Transport failures.** Where the oracle or the measurement pins TypeScript's text ("fetch failed", "terminated"), native gives it. Any other transport exception becomes a fixed message, never the exception's own text, which can name the host.
- **Depth.** Native refuses provider JSON nested beyond a fixed bound before any recursive walk.
  - TypeScript fails such a payload when a recursive check or `JSON.stringify` exhausts its stack.
  - .NET cannot recover from a stack overflow (P2.3a F2).
  - Slice b sets the bound and records its evidence.
- **Chunking.** TypeScript's reader normalizes line endings per decoded chunk, so a CRLF split across two reads adds a blank line. Its 1 MiB check measures the whole buffer, including events not yet split off.
  - Native reproduces both for the same chunks, and the vectors drive both runtimes with identical chunks.
  - On a live connection, undici and .NET split bytes differently, so these outcomes can differ there.
- **`Retry-After`,** which only the orchestrator reads. Delta-seconds (with JavaScript's `Number`) and the three HTTP-date forms are ported, with vectors on a fixed clock. Any other spelling `Date.parse` accepts is recorded as a difference for the orchestrator slice.
- **The credential is a .NET string** and cannot be zeroed; TypeScript also holds it as a string. The plan's zeroed `byte[]` rule is for the host vault (P3).

**Decisions for Rudy.**
1. **Credential source and binding before the cutover.** Recommended:
   - Native accepts a credential only through the `runtime.credential` stdio frame, exactly as TypeScript does. That means its strict schema, the binding checked against the stored profile, memory only, registration with the redactor, verification cleared, and refusal while a response runs.
   - During P2.4 the frame's only sender is the tests, with values generated at run time.
   - No vault, file or environment source, and no Electron change. The DPAPI vault stays in P3.
2. **The MCP repair a credential triggers.** In TypeScript, a new credential queues `repairMcpConfigurations`. Stored MCP configurations that the redactor would now change are rewritten after a verified, protected backup. MCP methods, starts, sends and probes wait for that repair. Native has no MCP slice yet.
   - **(A)** Port the repair now: the stored-MCP sanitizer, the verified protected backup and the guarded rewrite, ahead of the MCP slice.
   - **(B, recommended)** Fail closed until the MCP slice. While any MCP server row is stored, native refuses `runtime.credential` with a fixed message and writes nothing. P2.4's fixtures hold no MCP rows. The MCP slice ports the repair and lifts the refusal.
     - **Correction, found in P2.4c:** the v3 fixture does save MCP servers. See P2.4c for how its oracle case and native test handle that.
3. **API kinds and capabilities.** Recommended: all three Azure kinds, with every capability and every task kind listed under Scope. Coordinated orchestration, MCP tools and browser tools stay refused. Alternative: Responses only in P2.4, and the other two kinds in a later slice.
4. **Live providers and the test transport.** Recommended:
   - **No live or paid request in P2.4,** from any test, tool or person. Every adapter test injects fetch (TypeScript) or an `HttpMessageHandler` (native). Tests inspect the production handler but never send through it.
   - **No product code path, environment variable or build flag can point provider traffic at another host.** The stdio differential therefore covers only the provider paths that never reach the network:
     - saves, credential frames and their refusals;
     - the offline profile's probe, and an external probe without a credential;
     - gated turns.

     The oracles prove adapter, probe and turn behaviour in process.
   - **Fixture credentials** are built at run time and recorded in vectors as a placeholder, in shapes that secret scanners don't match (the P2.3 GitGuardian lesson).
   - **Live qualification** with the C# adapters (`profile.probe` against real deployments) stays the plan's operator gate: Rudy runs it, not before P4 unless he asks. On 19 October 2026 he scheduled it for the P4 rehearsal (see the P5 cutover readiness list).
   - **Alternative, not recommended:** a Debug-only loopback seam (connection redirection plus a test certificate) for a process-level differential of streamed turns. It would put traffic redirection for credentialed requests into runtime code.
5. **Certificate trust.** Recommended: accept the Windows store, as the plan's "no certificate callback" implies, and record the measured difference above. The alternative, trusting only Node's bundled roots, needs a certificate callback and a shipped root list.

**Standing holds, unchanged:**
- no shipping build or runtime selector, and no Electron-side .NET enablement;
- no schema v6 or adoption, and isolated fixtures only;
- durable intent before any mutation, and unknown outcomes never retried;
- new-file creation disabled, coordinated mode refused, and no cutover.

Each slice is committed locally and sealed. The stack goes up as one draft pull request on Rudy's approval and merges on his approval.

**Evidence, per slice.** The P2 pattern applies throughout:
- TypeScript oracles pinned to their sources' SHA-256, regenerated only with their `P2_WRITE_*` flag, and native replays;
- every difference named;
- validation from a `git archive` export: locked restore, a Release build with warnings as errors, the full native suite, `pnpm check` and `git diff --check`;
- a seal per reviewed range, mutation runs, and a docs entry.

What each slice adds:
- **a.** `tests/p2/provider-transport.test.ts` (`P2_WRITE_PROVIDER_TRANSPORT`) drives the shipping `createProvider(kind, { fetch })` with a recording fetch and chunk-exact streams.
  - **Requests:** the URL, method, headers (the credential as a placeholder), body bytes and `redirect` of each one.
  - **Framing:** BOM, invalid UTF-8, CR and CRLF, split multi-byte characters, `data:` without its space, multi-line data, comments, events without data, a trailing event without its blank line, and each cap at and over its limit.
  - **Responses:** HTTP errors and `Retry-After` on a fixed clock, and statuses without a body.
  - **Cancellation:** before the request is sent and during a read.
  - **Hostile endpoints:** case, a trailing dot, userinfo, query and fragment, ports, IDN and percent-encoding, numeric IPv4, and look-alike suffixes.

  `ProviderTransportTests` replays it through a recording `HttpMessageHandler` whose stream returns exactly one recorded chunk per read. Native-only tests:
  - the handler's configuration;
  - a redirect status: one request, never followed, and the credential sent nowhere else;
  - mapped transport failures;
  - a cancelled read disposing the response.
- **b.** `tests/p2/provider-streams.test.ts` (`P2_WRITE_PROVIDER_STREAMS`) carries the cases of the four TypeScript provider suites and generated variants for each kind:
  - order violations, duplicates, and truncation at every event;
  - refusals in each position;
  - unsafe and inconsistent usage, and metadata bounds;
  - non-string ids and partial JSON;
  - JavaScript's JSON semantics: duplicate keys, `__proto__`, large and non-finite numbers, lone surrogates;
  - round trips, compared byte for byte, including Anthropic signatures and Responses' encrypted reasoning.

  `ProviderStreamTests` replays it. Native-only tests:
  - the depth bound;
  - no event after a failure;
  - no tool call emitted before the completion validates it.
- **c.** `tests/p2/profiles.test.ts` (`P2_WRITE_PROFILES`) drives the shipping `RuntimeService` with `createProvider` over a recording fetch, through `dispatch` and `setCredential`, on disposable fixture eras.
  - **Each step records** its value or refusal, the rows it changed in `profiles`, `usage_requests` and `events`, its notifications, and every request the provider received.
  - **Saves:** validation and endpoint refusals, effort before v4, the reserved offline profile, verification kept and cleared, and binding changes.
  - **Credentials:** refusals for the binding, a running response and shutdown.
  - **Probes:**
    - success for each kind, and each failure stage;
    - the deadline, and a stream that continues after cancellation;
    - a profile or credential change during a probe, and a second probe refused;
    - the offline profile's probe.

  `ProfileTests` replays it through `DevelopmentChat` with an injected handler, and the stdio differential adds the paths that never reach the network. Native-only tests:
  - the credential canary appears in no output line, event, row, error or standard error;
  - malformed credential frames are answered as TypeScript answers them (`id` "invalid", "Invalid request.");
  - shutdown during a probe;
  - decision 2.
- **d.** The Git-chat oracle gains external-profile cases, or a sibling `tests/p2/external-chat.test.ts` (`P2_WRITE_EXTERNAL_CHAT`) does. Scripted streams for each kind run through `createProvider` over a recording fetch.
  - **Cases:**
    - projectless, folder and Git chats, and a coding turn;
    - unverified and tools-unverified profiles, with channel tools only when verified;
    - a missing credential, admitted and then failed, as in TypeScript;
    - HTTP errors, failures before and after usage, and cancellation with usage;
    - metadata attribution, and budget and context warnings on measured usage;
    - a stored continuation after a profile edit.
  - **Each step records** rows in the seven tables plus `usage_requests`, the notifications, and the requests received.

  A `GitChatTests`-style replay runs natively, and the stdio differential adds the gated refusals. Cases ported from the integration suites:
  - `security.test.ts`: a probe result captured before a credential change;
  - `security-audit.test.ts`: canaries split across chunks and carried in exception messages;
  - `runtime.test.ts`: a credential split across frames;
  - `coding.test.ts`: a secret-bearing continuation.
- **Reviews.**
  - **Security** on every slice: `cloud-security-vulnerability-expert`, Opus at high effort, below the owner. Credentials, the network and the endpoint allowlist are its subject.
  - **Data integrity** on c and d, which write profiles, usage requests and provider state: `db-steward`, Sonnet at high effort.
- **Electron E2E** is not required: no renderer, IPC or user-path source changes.

**Risks.**
- **The credential reaching another host.**
  - The endpoint rule runs twice: at save, and as `normalizeEndpoint` before each request.
  - `EcmaUrl` must agree with WHATWG on every hostile spelling, or a key could reach a host TypeScript refuses.
  - Mitigation: the shared hostile-endpoint vectors (a); redirects never followed; no proxy and no default credentials.
- **Continuation fidelity.**
  - Opaque provider items (Anthropic thinking signatures, Responses' encrypted reasoning) are parsed with JavaScript's semantics, stored and sent back.
  - One changed byte breaks the provider's check of its own state, and only a live call would show it.
  - Mitigation: byte-for-byte round-trip vectors (b). The live gate stays open until Rudy runs it.
- **Stack depth.** A recursive walk of provider JSON can end the native process where TypeScript throws. Mitigation: the depth bound (b).
- **Accounting.**
  - Native settles measured usage for the first time. Unsafe integers, a double charge or usage lost on failure would misstate budgets.
  - Mitigation: the existing settlement primitives, vectors for every outcome with and without usage, and the data review.
- **Loop affinity.**
  - HttpClient completions, the SSE reader and the probe's deadlines must resume on the runtime loop, without banned timers.
  - Mitigation: `RuntimeLoop.Delay`, `AssertCurrent` in the reader, and the loop tests.
- **Shutdown during a probe.**
  - A probe can run four 20-second requests, and the process drains for at most 45 seconds.
  - A probe cut off leaves its usage request pending; recovery marks it interrupted, as after a TypeScript kill.
- **Chunk-dependent framing** (above) is pinned only for identical chunks.
- **Not tested against Azure.** No P2.4 evidence shows the C# adapters against real deployments. The TypeScript adapters' live qualification is also an open release gate.
- **Token-shaped fixtures** in tests and vectors (GitGuardian, P2.3): built at run time and recorded as placeholders.

### Azure adapter requests and transport (P2.4a)

**What it is.** `Foundry.Providers` gains the request half of `AzureProvider`, its transport and SSE reader, and the Chat Completions parser. It is unwired: nothing in `DevelopmentChat` or `Program` constructs it, so the development runtime stays at 41 of the 89 methods.
- **Requests** (`AzureRequests`), for all three kinds, in TypeScript's order of checks: the profile's kind, its effort, the credential, the caller's cancellation, the body with its continuation and tool results, the endpoint, then the request.
  - **Bodies** are TypeScript's object literals in their property order, so `JsJson` sends the same bytes.
  - **The endpoint rule** is the WHATWG reading the provider fingerprint already uses. The new `Compatibility.AzureEndpoint` adds TypeScript's second message for a URL that parses under another scheme (`ftp:`).
- **The transport** (`AzureTransport`): one POST per request through `HttpMessageInvoker`, as listed under the transport rules above.
  - **The production handler** follows no redirect and keeps no cookies. It uses no proxy, no default credentials and no decompression, adds no certificate callback, and sends header values as Latin-1 bytes. It reads nothing from the environment.
  - **Bounds:** 10 seconds to connect and 300 seconds to receive headers, both "fetch failed". A read that sees no byte for 300 seconds is "terminated".
  - **Redirects:** any redirect status (301, 302, 303, 307 or 308), with or without `Location`, is "fetch failed" before the body is read.
  - **Statuses:** a 204 or 205 has no stream, and any other status outside 2xx is `ProviderHttpException` with TypeScript's `Retry-After` reading.
- **The SSE reader** (`SseReader`) decodes as TextDecoder does, normalizes line endings per read, keeps the three caps and parses `event:` and `data:` as `parseSse` does. Cancellation is checked before and after each read only, so frames already read are still delivered after an abort, as in TypeScript.
- **The Chat Completions parser** (`ChatCompletionsStream`): text, metadata from every frame, the last valid usage, tool-call assembly by index, and every terminal check, with the calls emitted only after all of them.
- **JSON** (`ProviderJson`) is `JSON.parse` over the decoded text: source order, a repeated key keeps its first position and last value, `__proto__` is an ordinary key, `1e400` is infinite, and lone surrogates survive.
- **`ProviderRequest`** now carries tool definitions (`ProviderTool`) instead of names, plus the stored profile and the credential. Its text never prints the credential. The offline provider and the agent loop read names, and nothing else changes for them.

**Measured, against undici** (Electron 44.4.1's Node 24.21.0, run as Node; loopback servers, and a blackhole address for the connect bound):
- **Redirects:** a 302 with a `Location` and a 307 without one both reject with `TypeError: fetch failed` (cause "unexpected redirect").
- **Responses and URLs:** a 204 has no body, and an empty `?` is not sent.
- **Credential header values:** fetch trims HTTP whitespace from both ends of the value. NUL, CR and LF inside it are refused ("Headers.append: … is an invalid header value."). A character above U+00FF is refused ("Cannot convert argument to a ByteString …"). Other control characters fail as "fetch failed". Latin-1 characters are sent as single bytes.
- **Bounds:** connecting gives up after 10.6 seconds ("fetch failed", `UND_ERR_CONNECT_TIMEOUT`). Headers time out after about 305 seconds ("fetch failed", `UND_ERR_HEADERS_TIMEOUT`), and an idle body after about 305 seconds ("terminated", `UND_ERR_BODY_TIMEOUT`).
- **Certificates:** the default CA set is the 121 bundled roots plus the 105 roots in this machine's Windows store.

**Differences, all fail-closed or invisible on success:**
- **The credential header's messages never include its value.** fetch's messages name the offending character's index and code point, or echo the trimmed value (TypeScript finding T-2 below). Native uses fixed messages.
- **Depth.** Provider JSON nested deeper than 256 levels is refused as malformed, and tool-call arguments that deep as incomplete JSON. TypeScript fails such a payload only when a recursive check or `JSON.stringify` exhausts its stack. A stack overflow would end the .NET process.
- **Transport failures.** Before a response they are "fetch failed", and while reading one "terminated", whatever .NET reports. The cause is kept only as the inner exception, which the runtime never reports.
- **`Retry-After`.** Delta-seconds (JavaScript's `Number`) and the three HTTP-date forms are read, in UTC and ignoring the weekday. Other spellings that `Date.parse` accepts give no value natively: the vectors' "-1" and "5, 6" (two headers, joined), both of which TypeScript reads as past dates (0 seconds). asctime is left out of the vectors because V8 reads it in local time. Only the orchestrator reads the value.
- **Headers the transport adds,** certificate trust, and chunking, as named in the plan above.
- **Endpoints, after the security review (F1, F2):**
  - A host with a right-to-left character is refused, with the first message. WHATWG applies the IDNA Bidi rule to such hosts and refuses those that break it; .NET's `IdnMapping` applies no Bidi rule, so the provider endpoint rule refuses them all. Azure resource names are ASCII.
  - A host WHATWG accepts but .NET's `Uri` cannot hold (a sub-delimiter such as `!`, `(` or `~`) gets no request and fails as "fetch failed". TypeScript sends that request and fails at name resolution with the same message.
  - **An ASCII `xn--` label that is not valid Punycode** (`xn--`, `xn--zz`, `xn--a`, `xn--abc-`) is refused natively, with the first message. This is fail-closed: the host is still under an Azure suffix.
    - **Found by PR #47's CI.** The URL parser of Electron 44.4.1's Node 24.21 (ada 4.0.0) accepts these hosts, so TypeScript sends the request. The Node 24.14 (ada 3.4.2) that first generated the oracle refuses them.
    - **Their outcome depends on the Node version,** so the oracle leaves them out, as it leaves out asctime. `ProviderTransportNativeTests` pins native's refusal.
    - **The security reviewer reran both endpoint differentials** (1,613 spellings) on Electron's Node:
      - Native accepts nothing that TypeScript refuses, under either the adapter rule or the save rule. Where both accept, the targets are identical.
      - Every difference is native refusing: 230 adapter spellings and 38 save spellings. They are this class, the sub-delimiter hosts, the hyphen-edge labels and the empty labels, all named.
      - One class now agrees: Arabic-Indic digit hosts (`١٢`), which Node 24.14 accepted, are refused by both runtimes.
    - **Decided by Rudy, 18 October 2026: keep the refusal.** Native does not follow ada 4.0.0 in accepting these hosts.
    - **Follow-up:** the oracles are being pinned to Electron's Node (`.node-version`, a CI check and a guard on regeneration) in a separate change, so that vectors cannot drift from the shipping runtime again.

**Native corrections from the review (F1).** These were defects in the shared URL reader, where TypeScript already refuses the spellings; they apply to the `http-url` contract too.
- **Userinfo:** `https://::@host` now counts as credentials. WHATWG reads it as an empty username and the password ":"; the reader used to see empty userinfo.
- **Punycode:** an ASCII `xn--` label that is not valid Punycode (`xn--`, `xn--zz`, `xn--a`, `xn--abc-`) is refused. `IdnMapping` used to check only the labels it encoded itself. Node 24.14 refuses these labels too, but Electron's Node 24.21 accepts them, so on the shipping parser this is a named difference (above).
- **Not changed:** the `http-url` contract still applies no Bidi rule, so the browser contract accepts some hosts WHATWG refuses. This is carried to P3.

**TypeScript findings, not fixed under the freeze** (neither is a security or data-loss defect). T-1 was later fixed by Rudy's decision:
- **T-1, Anthropic resumption sends one tool result.**
  - **Mechanism:** when a stored Anthropic continuation has more than one pending call and the next request carries exactly one user message, `nativeRequest` merges that message with the first result's block only. That is the path `prepareRequest` takes after an interrupted turn, such as a cancellation while two tool calls ran.
  - **Effect:** the other `tool_use` blocks reach Anthropic with no `tool_result`, which its API refuses. The task cannot continue under that profile, and every later turn fails the same way; the retained state is intact.
  - **Native:** it ported the behaviour, and the P2.4b vectors pinned it.
  - **Decided by Rudy, 18 October 2026: fix it in both runtimes.** Both now send every result. See the dual-landed entry "Answering every pending Anthropic call on resumption".
- **T-2, an invalid credential header echoes the credential.** undici's invalid-header message holds the trimmed header value. The redactor knows only the untrimmed secret and its JSON escapes, so a credential with surrounding whitespace and an inner CR, LF or NUL would reach a task's failure reason or a probe's detail.
  - **Not reachable through the shipping UI:** the credential field is an `<input type="password">`, which strips CR and LF, and a NUL cannot be typed into it.
  - **Native** never echoes the value.

**Evidence.**
- **The oracle.** `tests/p2/provider-transport.test.ts` drives the shipping `createProvider(kind, { fetch })` through `tests/p2/provider-fetch.ts`, whose response streams return exactly the listed chunks, one per read. It runs 397 cases: 389 before the review, the review's 10 spellings, and the re-review's 2 (P2.4b N3), less the 4 invalid-Punycode spellings whose outcome depends on the Node version (above); the vectors are bound to `index.ts`, `limits.ts` and `tool-definitions.ts`, and regenerating them requires `P2_WRITE_PROVIDER_TRANSPORT=1`. The cases:
  - **Requests:** each kind's body, with system, assistant and user messages, a lone surrogate, the runtime's tool schemas and fixture tools; every effort for each kind; output limits.
  - **Checks before any request:** missing, empty, whitespace-only and JavaScript-whitespace credentials; abort before sending; a mismatched kind.
  - **Continuations** for each kind: results in the request's order, a missing, duplicated, misnamed or foreign result, calls that are absent, invalid or not an array, invalid state, and data that is not an object.
  - **Endpoints:** 43 spellings, 6 more from the review and 2 from the re-review. Accepted ones include case, `:443`, a dot path, `%2e`, an empty userinfo, backslashes, tabs and spaces, `%2E` in the host, IDN, and the four suffixes. Refused ones include `http:`, userinfo, a query or fragment, other ports, paths, `//`, look-alike suffixes, a trailing dot, a bare suffix, IP addresses and `ftp:`.
  - **Statuses:** 14 failures, 2xx variants, 204 and 205, and 26 `Retry-After` headers on a fixed clock (one absent, one repeated).
  - **Framing:** CR, CRLF and a CRLF split between reads (also before an event name), the byte order mark at the start, split across reads and after the start, invalid and split UTF-8, `data:` spacing and Unicode whitespace, multi-line data, comments and other fields, event names, `[DONE]` spellings, an abort with frames still buffered, a stalled stream, a lost connection, and each cap at and over its limit.
  - **The Chat Completions parser:** content and empty content, several choices, finish reasons and the terminal checks, `[DONE]` order, refusals, legacy function calls and errors (each with its usage), malformed JSON, duplicate keys, metadata bounds, usage reports (JSON `null` subsets among them), and tool-call assembly.
- **The replay.** `ProviderTransportTests` replays every case through a recording `HttpMessageHandler`. It reproduces each request (URL, method, the adapter's four headers and nothing else, body bytes), every event and every error, and asserts that no query or fragment marker is sent. The two `Retry-After` spellings above are its only named differences.
- **Native-only tests** (`ProviderTransportNativeTests`):
  - the production handler's configuration;
  - redirects, refused and never followed;
  - the headers and body bounds, and cancellation during the request and during a read, with the response stream disposed on every path;
  - the measured credential-header rules, with no part of a refused value in its message;
  - the depth bound at 256, 257 and 500,000 levels;
  - the credential absent from every failure message and from `ProviderRequest`'s text.
- **Mutations** (`foundry-evidence\p2.4-a\mutations-run1` and `run1b`): 25, all caught. They removed the byte order mark drop, the lone-CR normalization, the abort check's placement, the `data:` trim, call validation, the usage on a reported error, the terminal checks, JSON `null` subsets, the `Retry-After` cap, TypeScript's Anthropic merge, `store: false`, the redirect refusal, the credential header's trim and Latin-1 check, the depth bound, the headers and body bounds (both tests then hit the run's 300-second cap), the empty query marker, repeated-key order and infinite numbers; and moved each cap by one and the credential check to .NET whitespace. The first run skipped two whose patterns did not match the source, which held the literal characters instead of their escapes; the escapes are restored and `run1b` caught both.

- **The review's spellings** joined the oracle. Its four invalid-Punycode spellings later left it, after PR #47's CI (above).
  - Of the six that remain, TypeScript refuses two before any request, and so does native.
  - The other four reach TypeScript's recording fetch and are the replay's named endpoint differences above: the Hebrew host and three sub-delimiter hosts.
- **Hardening from the review,** pinned by tests:
  - the production handler propagates no `traceparent` or `baggage` from an ambient `Activity` (F3);
  - `ProviderRequest`'s wire form, which `JsJson` writes, leaves out the credential (F4);
  - the handler-injecting `AzureTransport` constructor is internal, so product code can construct only the production transport (F6).

**Validation (local, from `git archive` exports).** Evidence, seals and mutation logs are in `foundry-evidence\p2.4-a`.
- **`c02bd98`** (`run2`; `run1` failed to export, because PowerShell 5.1 corrupted the piped tar stream; the script now pipes through `cmd`):
  - Release build with warnings as errors: clean.
  - Native suite: 7,747 tests, 7,745 passed, 0 failed, 2 expected skips.
  - `pnpm check`: 588 passed across 93 files.
  - The stdio differential: 2 of 2.
  - `git diff --check`: clean.
- **The review fixes:** see the re-review below.

No renderer, IPC or user-path source changed, so no Electron E2E run was required.

**Independent review of `87cbcd6..c02bd98`.** Security (`cloud-security-vulnerability-expert`, Opus at high effort): **GO with conditions**, with no critical or high finding.
- **What it ran:**
  - It verified the seal, built an export, and ran four classes (487 passed) and the oracle.
  - It ran an endpoint differential of 1,613 hostile spellings against a verbatim copy of `normalizeEndpoint` and `buildTarget` on Node's WHATWG URL.
  - It sent through the production handler to a raw loopback server only.
- **Confirmed:**
  - no accepted endpoint resolves outside the four suffixes, and both runtimes build the same target wherever both accept;
  - the production handler went direct with proxy variables set, did not follow a real 302, sent the credential as Latin-1 bytes, and did no decompression, cookies or authentication;
  - every refusal and transport failure has a fixed message;
  - the depth bound keeps every recursive walk within about 262 levels;
  - tool calls are emitted only after every check, and usage handling matches `usageFrom`.
- **F1 (medium), fixed:** the endpoint rule disagreed with WHATWG for `::@` userinfo, invalid Punycode and Bidi-rule violations. Native sent a request TypeScript refuses, though always to an Azure host. On Electron's Node 24.21, TypeScript does send the invalid-Punycode requests, so native's refusal of them is a named fail-closed difference.
- **F2 (low), fixed:** `UriFormatException` escaped for hosts both URL readers accept.
- **F3 (low, latent), fixed:** ambient `Activity` headers on the credentialed request.
- **F4 (low, no caller), fixed:** `JsJson` would have written a request's credential.
- **F5 (informational), not changed:** the reader's per-read work over the buffered text is quadratic under a slow drip, as in TypeScript, bounded by the 8 MiB cap and the turn limit.
- **F6 (informational), fixed:** the public handler seam.
- **T-1 and T-2** were confirmed from source, and their classification stands. On T-2, the reviewer noted that main checks only the credential's length, so the guard rests on the password input. It suggested that slice c also register the trimmed credential with the redactor.

### Responses and Anthropic parsers (P2.4b)

**What it is.** `ResponsesStream` and `AnthropicStream` port `streamResponses` and `streamAnthropic`, and `AzureProvider` now reads all three kinds. The adapter is still unwired, so the development runtime stays at 41 of the 89 methods.
- **Responses:**
  - **Events:** text deltas are emitted as they arrive. Output items are refused if a refusal or computer call appears anywhere in them.
  - **One completion:** its status must be `completed` with no incomplete details. Its output, when present, must be an array of objects that contains every streamed item. Items match by type and id and, for a function call, by call id, name and argument text, all with JavaScript's `===`; otherwise by serialized content.
  - **Failure events:** failed, incomplete, error and refusal events report their metadata and usage, then fail the response.
  - **Calls and continuation:** calls come from the authoritative output, after every check. The continuation is the request's input with that output appended.
- **Anthropic:**
  - **Content blocks** are assembled by index with JavaScript's `Map` semantics, so a raw `-0` names block 0. Text, thinking, the signature (replaced, not appended) and tool-use JSON are collected; an empty text delta is kept but not emitted.
  - **Usage** is the message's input with both cache buckets added once, plus the output.
  - **Stop reasons:** any stop reason other than `end_turn` or `tool_use` fails the response, even when a valid one comes before or after it.
  - **Order and completion:** only pings may follow `message_stop`. Every block must have stopped, and the stop reason must agree with the calls.
  - **Continuation:** the messages with the assistant's blocks appended, the system text and the calls.

**Differences.** None beyond the depth bound named in P2.4a, which `ProviderStreamNativeTests` exercises: payloads exactly at the bound pass the recursive checks and their continuation's serialization, and a refusal at the deepest level is still found.

**Evidence.**
- **The oracle.** `tests/p2/provider-streams.test.ts` streams 145 inputs through the shipping adapter: 70 Responses, 74 Anthropic and one Chat Completions case for a `-0` index. 91 of them end in a refusal or failure. The vectors are bound to `index.ts` and `limits.ts`; regenerating them requires `P2_WRITE_PROVIDER_STREAMS=1`.
  - **Follow-ups.** Seven cases continue: the stored continuation, with a result for each of its calls, becomes the next request. That pins the exact next body, including Anthropic's thinking signature, Responses' encrypted reasoning, and T-1's single-result merge (two pending calls and one user message send one `tool_result`).
  - **Since the T-1 fix** (dual-landed entry): there are 146 inputs, 75 of them Anthropic, and eight follow-ups. Case 86 sends both results, and the appended case 145 continues three calls with one user message.
  - **Responses cases:** the event order, item and completion cross-checks (ids, call fields, content key order, object-typed fields), unsupported content at any depth, incomplete and failed completions with their usage, malformed calls and arguments, and cancellation and transport failure.
  - **Anthropic cases:** usage with cache buckets and invalid values, block and delta errors, stop reasons in every order, pings, errors, `__proto__` and `1e400` in tool input, and the resumed turn.
- **The replay.** `ProviderStreamTests` replays every case through P2.4a's recording handler. It builds each follow-up from native's own continuation, and the next body matches TypeScript's byte for byte.
- **Mutations** (`foundry-evidence\p2.4-b\mutations-run1` and `run1b`): 22, all caught.
  - **They removed:** the after-completion check, item screening, computer calls, each cross-check field, incomplete details, the omitted-output rule, refusal event types, the output in the continuation, duplicate-block and stop checks, the cache sums, the null-cache fallback, tool JSON parsing, signature replacement, `-0` keys and the system text.
  - **They also changed:** `===` to value comparison, empty text to emitted, and which stop reason wins.
  - **First run:** two survived, value comparison and an earlier `end_turn` forgiving a later failure. Both are now pinned and caught. One mutation did not build until it was rewritten.

**Review fixes (`49cbbad`, and the TypeScript half after it).**
- **N1: append in linear work.** Anthropic text, thinking and tool JSON, and Chat Completions argument text, were rebuilt by concatenation on every delta.
  - The review measured 20 s and 75 GB for 10,000 deltas; TypeScript took 0.1 s.
  - They now append to builders. A field's position is fixed at its first delta, as JavaScript's assignment fixes it, and the signature still replaces.
- **N2: index the completion.** See the dual-landed entry "A linear Responses completion check".
- **Tests.** `ProviderStreamNativeTests` reads each parser on one thread and bounds what it allocates at 512 MB.
  - With the fixes: 73 to 161 MB, in 0.6 s.
  - Against the previous parsers, all three tests fail: 18 to 36 GB, in 20 s.

**Validation.** `b610736` (`foundry-evidence\p2.4-b\run2`):
- Release build with warnings as errors: clean.
- Native suite: 7,916 tests, 7,914 passed, 0 failed, 2 expected skips.
- The stdio differential, and `git diff --check`: clean.
- `pnpm check`: 585 of 589 passed. The four failures were Git-heavy integration tests in `publish.test.ts` and `continuity.test.ts`, which hit their 20- and 30-second timeouts under machine load. Both files then passed alone, 30 of 30 (`rerun-continuity-publish.log`).
- The review fixes are validated with P2.4c's final commit; see there.

**Independent review of `c02bd98..92a67b8`.** Security (`cloud-security-vulnerability-expert`, Opus at high effort): **the P2.4a fixes are GO; P2.4b is GO with conditions.**
- **What it ran:**
  - It verified the seal and built an export.
  - It ran the five provider and contract classes (4,770 passed) and both oracles.
  - It probed the native and TypeScript cost of hostile streams on identical bytes, the continuation's persistence round trip, and stack headroom.
- **Confirmed:**
  - F1 to F6 are fixed: the 1,613-spelling differential now shows no spelling accepted only natively.
  - The parsers match `streamResponses` and `streamAnthropic` line by line, with no gap that weakens a check.
  - Tool calls are emitted only after every check.
  - The continuation survives `JsJson`, `PersistedJson` and `JsJson` again unchanged, lone surrogates included.
- **N1 and N2 (medium), the conditions:** fixed, as above.
- **N3 (low):** U+007F in a host, and three unnamed fail-closed endpoint differences. Fixed and named in P2.4c.
- **N4 and N5 (slice d):**
  - N4: give the runtime loop's thread an explicit stack size, or run a depth case on the loop.
  - N5: replay the follow-ups through `SaveProviderState` and `ReadProviderState`.

### Profiles, credentials and probes (P2.4c)

**What it is.** The development runtime (`FOUNDRY_RUNTIME_P2_CHAT=1`) now serves `profile.save` and `profile.probe`, and accepts the `runtime.credential` frame. That brings it to 43 of the 89 methods. Turns still refuse every external profile; that is slice d.
- **`profile.save`** runs `service.ts`'s checks in their order:
  - effort before schema v4;
  - the reserved offline profile;
  - a profile that a running response uses;
  - the output budget;
  - then, for any profile that is not offline, the save-time endpoint rule (`Compatibility.ProfileEndpointError`), which gives "Invalid URL" or "Use a credential-free HTTPS Azure resource endpoint without a path or query." as TypeScript does.
  - A changed binding drops the credential, and every save starts a new generation. Verification is kept only when the runtime fingerprint is unchanged. The save publishes `profiles.changed`.
- **The `runtime.credential` frame** (decision 1):
  - `Program` checks it against its schema before any RPC handling. A frame that is neither it nor an RPC request is answered "Invalid request." under the id "invalid", as `entry.ts` answers it.
  - The binding must name the stored profile's API kind, endpoint and deployment.
  - The same credential again changes nothing.
  - Otherwise it is refused while a response runs and, under decision 2, while any MCP server is saved, with nothing written.
  - An accepted credential is held in memory only and registered with the redactor. Its generation advances, and verification is cleared without an event, as in TypeScript.
- **`profile.probe`:**
  - `AzureProvider.Probe` sends the adapter's four requests, each with a 20-second deadline: text with usage, the cancellation check, a fixture tool call, and its continuation.
  - On schema v4 and later, each request is a probe usage request, settled with its measured usage and redacted metadata.
  - A result is saved as verification only when it found streaming and cancellation, and only if neither the profile nor its credential changed while it ran. A failed probe clears verification if nothing changed.
  - One probe per profile runs at a time. The offline profile's probe is the fake provider's.
  - Shutdown waits for a running probe and then discards its result, as TypeScript does ("Runtime is shutting down.").

**Differences.**
- **The continued cancellation.** When a provider keeps streaming after the probe's abort, TypeScript leaves that request's stream open, so its usage request stays pending. Native closes it, records the request cancelled and unmeasured, and publishes its `usage.changed`. `ProfileTests` expects exactly that one change.
- **The trimmed credential is redacted too.** Fetch sends the credential trimmed of HTTP whitespace, so native also registers that spelling. This was the P2.4a review's suggestion on T-2.
- **Decision 2:** credentials are refused while any MCP server is saved.
- **Endpoints (P2.4b review N3).**
  - U+007F in a host is now refused, as WHATWG and TypeScript refuse it. The oracles hold both spellings.
  - Three remaining differences are fail-closed, because native refuses and TypeScript accepts:
    - a label with a leading or trailing hyphen, in a host that has non-ASCII characters (`IdnMapping` checks hyphens);
    - an empty label, such as `x..openai.azure.com`;
    - spellings that both refuse, with different messages: 30 in the oracle, and about 3% of the data review's 30,000 generated endpoints (below).
  - **A right-to-left host is refused at save** as "Invalid URL", as the adapter refuses it (P2.4a). TypeScript saves it, for example as `xn--4db.openai.azure.com`. So are hosts spelled with a full-width dot. These are fail-closed too.

**A plan correction.** Decision 2's text says P2.4's fixtures hold no MCP rows, but the v3 fixture saves MCP servers.
- Its oracle case therefore deletes them first (a `clear-mcp` step), so it can still record a v3 credential and probe.
- `ProfileNativeTests` pins the refusal against the unchanged fixture.

**Evidence.**
- **The oracle.** `tests/p2/profiles.test.ts` drives the shipping `RuntimeService`, with `createProvider` over the shared recording fetch, through `dispatch` and `setCredential`.
  - 7 cases and 94 steps on disposable fresh and v3 eras.
  - Each step records:
    - its value or refusal;
    - the rows it changed in `profiles`, `provider_requests` and `events`;
    - its notifications;
    - every request the provider received.
  - **Cases:**
    - saves and their verification;
    - credentials and their binding;
    - probes that verify each kind;
    - probes that fail at each stage;
    - a cancellation stream that continues after the abort;
    - changes while a probe runs, with held requests;
    - a version 3 database.
  - The vectors are bound to their sources; regenerating them requires `P2_WRITE_PROFILES=1`.
- **The replay.** `ProfileTests` replays every step through `DevelopmentChat` with the same identities, clock and answers. Each step must match exactly, except the named difference.
- **Native-only** (`ProfileNativeTests`):
  - decision 2 against the v3 fixture;
  - the credential, raw and padded, redacted from the probe's records;
  - a probe detail that quotes the credential (an Anthropic stop reason), redacted;
  - a blank credential, by JavaScript's trim, refused before any request;
  - a right-to-left host refused at save;
  - shutdown waiting for a probe;
  - the refusals while a response runs.
- **The stdio differential** adds the paths that reach no network, and checks that the credential appears in no reply, row or notification and that standard error is empty:
  - saves and their refusals;
  - credential frames: a stale binding, an unknown profile, two malformed frames, an accepted credential, and the same one again;
  - the offline probe, an external probe without a credential, and a missing profile;
  - a rebinding save.
- **Mutations** (`foundry-evidence\p2.4-c\mutations-run1`, `run1b` and `run1c`): 40, with 39 caught.
  - **`profile.save`:** they removed each check in turn, the endpoint rule, the credential drop, the generation, `credentialRef` and `profiles.changed`; kept verification across a changed fingerprint; and admitted an output budget equal to the context.
  - **The credential:** they removed the binding check, the same-credential shortcut, both refusals, both redactions, the generation and the cleared verification.
  - **`profile.probe`:**
    - They allowed two probes of one profile.
    - They ignored a credential change during a probe, kept verification after a failure, and left the detail and the reported model unredacted.
    - They recorded a cancelled request as failed.
    - They saved a probe after shutdown began, and let shutdown skip waiting for a probe.
    - They wrote probe usage before v4.
  - **The adapter's probe:** they passed a blank credential through, accepted text without usage, skipped or forgave the cancellation check, left the continuation token unchecked, changed the output limit, and reported a deadline as the abort.
  - **Endpoints:** they allowed DELETE, saved a right-to-left host, and dropped the other-scheme rule.
  - **The frame:** they stopped handling it, and stopped enforcing its schema. Both ran through the stdio differential.
  - **The first run:**
    - Three did not compile, because the replacements were constant patterns, and were rewritten for `run1b`. Two were caught there. The third, the right-to-left save, survived `run1b` because no test saved such a host; `run1c` caught it after its test.
    - Three survived. Two were gaps, now pinned by the native tests above: the redacted probe detail, and the blank credential. `run1b` caught both.
  - **Equivalent: verification without cancellation.** The adapters return all capabilities or none, so dropping the cancellation condition changes nothing.

**Validation.** `22b3454`, which also carries P2.4b's review fixes (`foundry-evidence\p2.4-c\run1`):
- Release build with warnings as errors: clean.
- Native suite: 7,937 tests, 7,935 passed, 0 failed, 2 expected skips.
- `pnpm check`: 591 of 591 passed across 95 files.
- The stdio differential: 3 of 3. `git diff --check`: clean.

**Independent review of `92a67b8..22b3454`** (seal `foundry-evidence\p2.4-c\seal-22b3454.txt`).
- **Security** (`cloud-security-vulnerability-expert`, Opus at high effort, the reviewer of P2.4a and P2.4b): **GO for both parts**, with no blocking finding.
  - **What it ran:**
    - It verified the seal and built an export.
    - It ran seven provider, profile and contract classes (4,791 passed) and four oracles.
    - It reran its hostile-stream cost probes, the 1,613-spelling endpoint differential, and a save-rule differential against `service.ts`'s rule.
  - **N1 and N2 closed:**
    - Anthropic and Chat Completions deltas: 20 to 23 s and 72 to 75 GB before, 0.1 to 0.2 s and 0.2 GB now.
    - The largest Responses cross-check: about 25 minutes before (extrapolated), 0.3 s now. TypeScript: about 3 minutes before, 0.1 s now.
    - It confirmed that both runtimes' keys match the old relation clause by clause.
  - **N3 closed:**
    - No spelling is saved natively that TypeScript refuses.
    - 29 spellings are refused only by native, all named above.
    - 31 spellings differ only in their message.
  - **Confirmed for P2.4c:**
    - The credential map only ever holds a credential bound to the stored profile's current binding.
    - Every refusal happens before any write or redactor registration.
    - Generations keep a stale probe from being saved.
    - Decision 2 writes nothing.
    - Each probe request has its own deadline, and the cancellation check holds.
    - Shutdown waits for a running probe and discards its result. That is safer than TypeScript, whose shutdown closes the Store while a probe still runs.
    - No traffic seam exists.
  - **Informational:**
    - **I1. Shutdown does not abort a running probe.** A slow endpoint can keep receiving credentialed probe requests until the host's 45-second drain ends the process. TypeScript behaves the same way. Not changed.
    - **I2. The production transport was never disposed.** Shutdown now disposes it, in P2.4d.
    - **I3. At cutover, decision 2 blocks external profiles for anyone with saved MCP servers.** Main loads credentials before `profile.probe` and `task.start`. This is the decision as recorded, and it belongs on the P5 readiness list until the MCP slice lifts it.
- **Data integrity** (`db-steward`, Sonnet at high effort): **GO**, with no critical, high or medium finding.
  - **What it ran:**
    - It verified the seal and built an export.
    - It ran both profile classes (16 passed) and the profile oracle.
    - It extended the oracle to the v1, v2 and v4 eras and to a failing probe across a change. It regenerated those vectors in its own export and replayed them natively: 12 of 12 passed.
    - It compared the save rule with `service.ts`'s over 1,668 written and 30,000 generated endpoints. No endpoint is saved natively that TypeScript refuses. 76 are refused only natively, all right-to-left or full-width-dot hosts, which is fail-closed.
  - **Confirmed:**
    - Every write path matches `service.ts` in its order, its boundaries and its behaviour on failure.
    - The named differences carry no data-integrity risk. The continued-cancellation row holds no budget, and a pending row is recovered as interrupted on the next start in both runtimes.
    - The races are covered: a change during a probe, two probes, and shutdown during a probe.
  - **Low:**
    - **L1. Memory before the write.** The credential and generation change before the write that clears verification, as in TypeScript. A failed write would stop the runtime. Not changed, for parity.
    - **L2. Records and their events commit separately,** as in TypeScript. The renderer re-reads state. Not changed.
    - **L3. The decision-2 test compared only profiles.** It now also compares usage records and events, in P2.4d.
    - **L4. Message-only differences are broader than the oracle's 30.**
      - 676 generated endpoints get TypeScript's generic refusal and native's "Invalid URL", such as scheme typos and right-to-left hosts.
      - 302 get the reverse, such as a misspelled scheme with a bad port.
      - Both runtimes refuse every one of them and write nothing.
  - **Informational:**
    - The upgrade slice must refuse while a probe runs, as `service.ts` does.
    - The MCP slice must lift decision 2 only together with the repair and the wait before a probe.
    - Shutdown does not dispose the transport; that is the security review's I2.

### External profiles in turns (P2.4d)

**What it is.** The development runtime now runs turns with external profiles, for all three kinds: projectless, folder and Git chats, and coding turns. `task.start` and `task.send` serve them, so the method count stays at 43 of 89.
- **Gates,** in `service.ts`'s order:
  - **At start:** an external profile needs a probe of its current configuration ("Probe this model profile successfully before starting a response."). A coding task needs one that found tools and continuation ("Probe tool and continuation capabilities before starting a coding task.").
  - **On every turn:** the probe gate again. A coding turn, or a task with native state, needs tools and continuation ("Probe tool and continuation capabilities before starting a response with tools.").
- **Requests:**
  - The adapter receives the credential held when the turn starts. Credentials cannot change while a response runs.
  - A missing credential is admitted and then fails ("A credential is required for this provider."), as in TypeScript.
  - A Git chat advertises the channel's tools only to a profile verified for tools and continuation. Otherwise it advertises nothing and has no instruction, but its requests still carry the channel's messages.
  - Stored continuations of an external kind resume. The offline provider's stage check now applies only to offline continuations.
- **Accounting:** usage and metadata read from the stream settle with their request.
  - Usage is normalized as `measuredUsage` normalizes it. The reported model and response id are redacted, and each is kept only within 200 UTF-16 units.
  - A completed request records its usage. A failed or cancelled request records "Provider reported final usage for an unsuccessful request." when usage arrived, and otherwise "Provider stream failed or was cancelled before usage was confirmed."
  - The completion's detail reports whether usage was known and the tokens charged. Schema v3 writes `usage_records` instead.
- **Failures** are recorded with redacted messages. That covers a credential split across stream chunks, and one quoted in a provider's message.
- **Review conditions:**
  - N4: the runtime loop's thread now has an explicit 8 MiB stack.
  - N5: each kind's send after a tool turn builds its request from the provider state the store saved.
  - Security I2: shutdown disposes the production transport once its turns and probes are done.

**Differences.** None: every step of the oracle matches.

**Evidence.**
- **The oracle.** `tests/p2/external-chat.test.ts` (`P2_WRITE_EXTERNAL_CHAT`) drives the shipping `RuntimeService`, with `createProvider` over a recording fetch. It has 9 cases, 107 steps and 103 provider requests, on disposable fresh and v3 eras.
  - **Each step records:**
    - its value or refusal;
    - the rows it changed in tasks, messages, provider requests, usage records, task starts, events, intents, projects and profiles;
    - its notifications;
    - every request the provider received.
  - **Settling:** a start, send or cancel settles before it is recorded: its task stops running, or (for a start or send) the provider parks a response after its last chunk. A record therefore never depends on how far a turn ran.
  - **Cases:**
    - projectless chats for each kind;
    - the gates, including a stale verification and one with tools but no continuation, with channel tools only when verified;
    - a missing credential, HTTP errors, and failures before and after usage;
    - canaries split across chunks, in provider messages, and in metadata;
    - cancellation with and without usage;
    - Git chats and coding turns with tool calls for each kind, a request after tools that reports no usage, a secret-bearing continuation, and a secret-bearing call;
    - budget and context warnings on measured usage, and the context and budget refusals;
    - a stored continuation after a profile edit: a rename resumes it, an endpoint change refuses it;
    - a version 3 database.
  - **Ported from the integration suites:**
    - the split canary (`runtime.test.ts`, `security-audit.test.ts`);
    - the canary in a provider's message (`security-audit.test.ts`);
    - the secret-bearing continuation and call (`coding.test.ts`).
    - The probe captured before a credential change (`security.test.ts`) is P2.4c's "changes while a probe runs".
- **The replay.** `ExternalChatTests` replays every step through `DevelopmentChat`, over the recording handler now shared with `ProfileTests` (`RecordingProvider`).
- **Native-only** (`ExternalChatNativeTests`):
  - A Git chat whose completion reaches the depth bound. The loop's thread screens it, serializes and saves its continuation, reads it back on the next turn and sends it.
  - Usage reported as the provider stops after a cancel is still charged to the cancelled request. A scripted provider times it.
- **`ProfileNativeTests`:** the decision-2 refusal now also leaves usage records and events unchanged (data review L3).
- **The stdio differential** adds the refused start of an unverified profile.
- **Mutations** (`foundry-evidence\p2.4-d\mutations-run1`, `run1b` and `run1c`): 25, with 21 caught.
  - **The loop:**
    - They stopped reading usage, and dropped usage that arrived with the abort.
    - They left the reported model unredacted.
    - They settled without usage or without metadata.
    - They ignored usage in the failure reason, the completion reason and the completion's detail.
    - They withheld the credential, and advertised channel tools to an unverified profile.
  - **`DevelopmentChat`:**
    - They removed each gate in turn, and dropped native state from the tools gate.
    - They accepted any earlier verification, and accepted tools without continuation.
    - They applied the offline stage check to external continuations, and sent external turns to the offline provider.
  - **The loop's thread:** a 256 KiB stack. The depth case then overflows it.
  - **The first run:** three survived, and the steps and test above now pin them: the stale verification, tools without continuation, and the usage arriving with the abort.
  - **Equivalent (4):**
    - An invalid usage replacing a valid one: a stream reports usage at most once.
    - An unbounded response id: the adapter already bounds it.
    - Either of the loop's two usage resets: each covers the other, as in TypeScript. Removing both is caught (`run1c`), since the data review's L2 step was added.

**Validation.** `65af437` (`foundry-evidence\p2.4-d\run1`):
- Release build with warnings as errors: clean.
- Native suite: 7,949 tests, 7,947 passed, 0 failed, 2 expected skips.
- `pnpm check`: 592 of 592 passed across 96 files.
- The stdio differential: 3 of 3. `git diff --check`: clean.

No renderer, IPC or user-path source changed, so no Electron E2E run was required.

**Independent review of `22b3454..65af437`** (seal `foundry-evidence\p2.4-d\seal-65af437.txt`).
- **Security** (`cloud-security-vulnerability-expert`, Opus at high effort): **GO**, with no reportable defect.
  - **What it ran:**
    - It verified the seal and built an export.
    - It ran seven classes, including the Git-chat, offline-tool and transport replays (502 passed), and both profile and external-chat oracles.
    - It scanned the vectors: the credential's placeholder appears only in request headers and scripted answers.
  - **Confirmed:**
    - No path reaches a provider for an unverified or stale configuration. A profile in use cannot be saved, credentials cannot change while a response runs, a new credential clears verification, and a probe result is saved only for an unchanged fingerprint and generation.
    - The credential reaches only the `api-key` header. Request bodies, saved answers, progress events, metadata, stop reasons, usage reasons and standard error cannot carry it.
    - Continuations and calls pass the secret-like screen before they are saved.
    - Channel tools and their instruction go only to a profile that `ProfileReady` accepts.
    - A stored continuation cannot resume under another profile or kind: the fingerprint, the continuation's kind, and the adapter each refuse it.
    - Settlement matches `agent-loop.ts`, and each request settles once.
    - The transport is disposed only when it is the runtime's own. A later use fails closed.
  - **N4 and N5 closed:**
    - The depth case runs on the loop's explicit stack, and fails on a 256 KiB one.
    - The replay compares 21 resumed request bodies byte for byte.
  - **The mutation equivalents** hold, judged from the code.
  - **Informational:** the gates run at the start of a turn, as in TypeScript. A probe that fails during a running turn clears verification; that turn continues, and the next one is refused.
- **Data integrity** (`db-steward`, Sonnet at high effort): **GO**, with no critical, high or medium finding.
  - **What it ran:**
    - It verified the seal and built an export.
    - It ran four classes (28 passed) and the oracle.
    - In its own export it ran shutdown during a running external turn, and a failed probe during a running turn on the same profile. Both finish every row, and nothing is half-written.
  - **Confirmed:**
    - Settlement, on v4 and v3, matches `agent-loop.ts`'s `settle()`: rows, budget arithmetic, reasons, outcomes and the completion's detail. A request settles once.
    - All eight refusals in the oracle write nothing. The gates run before the start is reserved, before any worktree intent and before admission, in `service.ts`'s order.
    - Each kind resumes from its stored state, and an endpoint change refuses it with nothing written.
    - The recorded tables cover everything these paths write.
  - **Low:**
    - **L1. A missing credential is admitted, then fails.** Credentials live in memory, but verification persists. After a restart, each send before the host sends the credential again keeps a full reservation charged. This is TypeScript's pinned behaviour, so it stays until the cutover decides it.
    - **L2. Removing both usage resets went unnoticed,** because every follow-up request in the oracle reported usage. A Git chat's request after its tools now reports none, and the paired mutation is caught.
    - **L3. No step refused for the context limit.** The budget case now has one, and it writes nothing.
  - **Informational:** the settling rule cannot observe a shutdown during a turn or two concurrent turns. The reviewer's own checks covered the first.

**P2.4 status.** Slices a–d are implemented, validated from exports and reviewed GO, on the local branch only. Rudy decided the open items on 18 October 2026:
- **T-1 (TypeScript, P2.4a):** fix it in both runtimes. Done, as the dual-landed entry "Answering every pending Anthropic call on resumption".
- **The TypeScript N2 fix (`bbfa5d5`):** keep it. He accepted the security classification.
- **The P5 items** (security I3, data L1 and the live qualification of `profile.probe`) are on the P5 cutover readiness list under the program rules.
- **Still held:**
  - Live qualification (`profile.probe` against real deployments) stays his operator gate. On 19 October 2026 he scheduled it once, during the P4 rehearsal, against the packaged candidate.
  - The draft PR, main integration and any publication need his approval.

### Oracle runtime pin

Recorded 18 October 2026. [PR #47](https://github.com/koala-man-64/foundry-agent-workspace/pull/47)'s Windows CI failed because its URL vectors were written on a local Node 24.14.0 (ada 3.4.2), while CI's floating `node-version: '24'` resolved to 24.21.0 (ada 4.0.0), the Node that Electron 44.4.1 ships. The oracles now record and check the shipping runtime:
- **Pin.** `.node-version` holds Electron 44.4.1's Node, 24.21.0. Both workflows install it through `node-version-file`. After downloading Electron, the portable job fails when Electron reports another Node or setup-node installed another, so an Electron upgrade moves the pin.
- **Write guard.** `tests/p2/oracle-node.mjs` refuses every `P2_WRITE_*` flag (33 oracle files, and P2.4's four once PR #47 merges) and the git-metadata oracle's `--write` unless the process is Electron's own Node at the pinned version. Check mode runs on any Node.
- **`pnpm oracle`** runs every P2 oracle under Electron's Node (`scripts/electron-node.mjs`, `ELECTRON_RUN_AS_NODE=1`); a `P2_WRITE_*` flag regenerates its oracle while the others are checked. The portable job runs it, and the git-metadata oracle, after `pnpm check`. That job's timeout is now 60 minutes: on a runner about twice as slow as usual, main's run on `9438440` took 43 of the earlier 45, 7.1 of them in this step.
- **Electron's Node is not Node's own build.** Electron 44.4.1 reports Node 24.21.0 with V8 15.2.124.19-electron.0 and ICU 78.2. Under it, `fs.rmSync` refuses read-only files (EPERM) and junctions (EISDIR). A recursive `fs.rmSync` also follows a junction inside the tree and empties its target. Node's own 24.21.0 build, which CI's `pnpm check` uses, does none of these: main's [portable run 39136280707](https://github.com/koala-man-64/foundry-agent-workspace/actions/runs/39136280707) passed all 92 test files. `fs.promises.rm` is correct on both. The runtime removes directories only through `fs.promises.rm` (command runner, hook runner, MCP host), so no shipping path is affected, and no fix is dual-landed.
- **Test cleanup.** Under Electron's Node, 12 P2 test files failed (21 tests) in scratch cleanup or in mid-test junction swaps. Git's read-only objects and junctions were the cause; no recorded outcome was involved. They now remove scratch trees with `tests/p2/scratch.ts`'s `removeTree`, which never follows a link and clears read-only files, and remove lone junctions with `unlinkSync`.

**Check-mode findings under Electron's Node.** No committed vector differs, so no vector was regenerated and none is machine-dependent. Main: **34 files / 61 tests** pass; the git-metadata oracle's **698 vectors** pass. A byte-identical `--write` there moved only its provenance stamp to `v24.21.0`. [PR #47](https://github.com/koala-man-64/foundry-agent-workspace/pull/47) at `1972de7` merged with this change: its four new oracles (external chat, profiles, provider streams, provider transport) pass too, **38 files / 65 tests**, once they call the guard and `external-chat.test.ts` cleans up with `removeTree`. Its `rmSync` failed with the same EPERM on Git's read-only objects. Whichever of the two changes merges second carries those four edits. PR #47 carries them in its merge of `main`, and `profiles.test.ts` cleans up with `removeTree` too.

Local validation: `pnpm check` passed type checking, lint and **587 tests across 92 files** on a standalone Node 24.14.0 (check mode). The portable job's new step (`pnpm oracle --maxWorkers=1 --bail=1`, then the git-metadata oracle) passed under Electron's Node in 229 seconds. Writes were refused on Node 24.14.0, and both the security and git-metadata regenerations under Electron's Node were byte-identical apart from the provenance stamp. Hosted CI has not run this change.

An independent read-only review returned **GO**. It found that `removeTree` threw when an entry vanished mid-walk, where `fs.rmSync`'s `force` did not; `removeTree` now treats an entry that is already gone as removed. Two minor findings remain, neither with a trigger in these tests:
- A directory swapped for a junction between `lstat` and `readdir` would be followed. No test changes a tree while `removeTree` runs.
- Clearing a read-only file's attribute through a hard link also clears it on a file outside the tree. The P2 tests hard-link only inside scratch.

**Not covered.** `packages/runtime/tests/agent-channel.test.ts` and `local-path.test.ts` (not oracles) still call `fs.rmSync` on junctions and fail under Electron's Node; nothing runs them there. The golden (`UPDATE_GOLDEN`) and P1 (`P1_WRITE_*`) vectors pass under Electron's Node but have no write guard.

### Rudy's decisions of 19 October 2026 and removable project drives

**Decisions.** Rudy decided three open items on 19 October 2026:
1. **Local aliases.** Native keeps refusing junctions, symbolic links, `subst` spellings and OneDrive placeholders, permanently. This is an approved difference to cutover, no longer an open decision (see "Reconciliation items" under P2 coverage).
2. **Drives.** Network and mapped network drives stay refused (decision 8). Removable drives are admitted for projects, matching TypeScript. Implemented natively below.
3. **Live qualification of `profile.probe`.** His operator gate runs once, during the P4 rehearsal, against the packaged candidate. He names the deployments and a spend cap then. No routine suite makes paid calls. It stays on the P5 cutover readiness list until it has run.

**Removable project drives.** Native only; TypeScript is unchanged. It reads no drive type for project folders, and its local-path push remotes stay fixed-only (`repository.ts:134`), a separate rule.
- **The primitive.** `DriveAdmission` (Foundry.Platform) has two values. `Fixed` admits fixed drives only. `Project` admits fixed and removable drives, and refuses network, optical, RAM-disk, unknown and unmounted roots. `DirectoryLease` keeps its fixed-only default for every chain; a caller passes `DriveAdmission.Project` to `AcquireExistingSharingWrites` to admit a project chain. The type is read from the drive root (`GetDriveType`) before any component is opened, so a refused drive is never touched.
- **Every caller, classified.**

  | Call site | What it opens | Admission |
  | --- | --- | --- |
  | `RepositoryFolderLease.TryOpen` | a project folder | `Project`. A mapped network drive keeps decision 8's message; any other refused type is "Project folder is unavailable." before anything on it is opened |
  | `GitRepositoryLease` (`Acquire`, `PinnedDirectory`) | the project chain, `.git`, gitdir and `commondir` | `Project`; a network drive keeps its message |
  | `RepositoryPaths.SameFolder` | both spellings' chains | named by each caller: `Project` from `project.add`, the folder-chat retry and the project channel; `Fixed` from `IsOwnWorktree`, the app-owned worktree folder |
  | `RepositoryService.IsGitWorkingTree` | Git's `rev-parse --show-toplevel` | `Project` |
  | `RepositoryService.OpenSafe` | the parent chain of file reads, listings and edits | `Project` |
  | `CommandRunner.AdmitWorkingDirectory` | a command's working directory inside the admitted root | `Project` |
  | `RepositoryService.PrepareWorktreeBase` | the app-owned worktree base | `Fixed`, unchanged |
  | `GitRunner.GuardHooks`, `HooksChanged` | the app-owned hooks folder | `Fixed`, unchanged |
  | `GitRunner.Resolve` | `git.exe` on `PATH` | fixed only, unchanged |
  | `CommandRunner.ResolveShell` | Windows PowerShell | fixed only, unchanged |
  | `RepositoryService.RequireSupportedRemotes` | a local-path push remote | `Fixed`, unchanged, as TypeScript |
  | `RepositoryService.IsNetworkRemote` | a remote's drive letter | unchanged: a network or unmounted letter is a share |
  | `Store`, `Store.Backup`, `DataClassifier.Inspect` | the data directory and its backups | `Fixed`, unchanged |

- **Differences from TypeScript, all fail-closed:**
  - Native refuses optical drives, RAM disks and roots whose type is unknown or that are not mounted. TypeScript reads no drive type for projects.
  - A mapped network drive is refused by type before any open; TypeScript refuses it after realpath.
  - A folder on a refused drive type is no longer probed to tell a file from a folder: it is refused as unavailable. Before this change native probed after the lease refused it.
  - **FAT and exFAT removable drives are still refused wherever folders are compared by identity.** `SameFolder` needs `FileIdInfo`, which P2.2c records that FAT and exFAT volumes cannot report. Many removable drives are formatted FAT32 or exFAT. Where TypeScript admits such a folder, native refuses it:
    - `project.add`, which always compares, with "The saved folder now resolves to a different location.";
    - the project channel of a Git task with no binding, with "Project channel requires an approved local identity.";
    - a failed start's retry, with "Project folder is unavailable or resolves to a different location."

    NTFS-formatted removable drives are admitted. This is not verified on hardware: no FAT or exFAT volume was available, and a fake drive type cannot change a file system. Whether this gap must close before cutover is Rudy's call.

**Tests.**
- **Seam.** `DriveAdmissions.Fake` reports a drive type for a folder and everything beneath it until disposal; the longest covering folder wins. It is internal, visible only to the Platform and conformance test assemblies. Each test fakes its own scratch folder, so tests running in parallel are unaffected. No physical drive is involved.
- **`DriveAdmissionTests`** (platform, 17): the rule for every `DriveType`, the path forms refused before any probe, the fake's scope, the fixed-only lease default, and refusal before opening for network, unmounted, unknown, optical and RAM-disk roots. A junction in the chain proves nothing was opened: an open would raise `ReparsePointException`.
- **`RemovableProjectDriveTests`** (conformance, 43): a positive and a negative test for every changed call site, plus:
  - the data directory (`Store`, its backup, `DataClassifier.Inspect`), the worktree base and the hooks folder still refuse a removable drive;
  - a project on a removable drive gets a task worktree end to end;
  - the project channel admits an 8.3 spelling of a folder on a removable drive. This reports a skip where the volume makes no short names; it ran here;
  - a failed start in a project on a removable drive is retried.
- **Differential.** Six P2 corpora replay every committed Node case with the fixture on a fake removable drive and its app-owned folders fixed: git identity (43), project admission (15), repository inspection (87), agent channel (5), task creation (19) and folder chat (1 scenario of 22 steps). TypeScript reads no drive type for projects, so its committed outcomes must hold unchanged, and they do. The command-runner corpus is not replayed, because it takes two and a half minutes; its call site has direct tests. No corpus, oracle or TypeScript source changed, so nothing was re-pinned.
- **Mutation check.** Each of the 15 changed checks was undone in turn: made fixed-only, its network message dropped, or the lease made to ignore its admission. Every one then fails at least one test. These mutations only narrowed checks; none removed a refusal. `IsGitWorkingTree`'s own refusal of Git's reported top level is not separately observable. The existing negative test is refused earlier, by the folder lease. When Git's top level names another drive (`core.worktree`), the final comparison returns false anyway, so only the no-open property depends on that check. The first run found two call sites no test reached: the project channel's comparison of an approved 8.3 spelling, and the folder-chat retry. The two tests above were added for them, and both mutations now fail. Logs: `mutation-check.log` and `mutation-check-gaps.log` in `foundry-evidence\removable-project-drives`.

**Residuals.**
- **Withdrawal.** A removable drive can be pulled out while its folders are pinned. Revalidation compares canonical paths, so another device with the same layout under the same drive letter would pass a later check. That needs physical access during the operation. It is not new: USB hard disks already report as fixed drives. TypeScript pins nothing at all.
- **The "No disk" prompt (follow-up, not in this change).** The native process never sets `SEM_FAILCRITICALERRORS`, which libuv sets for Node at startup. An open on a removable drive that has no media can therefore raise Windows' "There is no disk in the drive" prompt and block the runtime loop until someone dismisses it. This is possible, not observed. It is not new, because the classification probe could already open such a drive, but admitting removable drives makes these opens routine.
- **Decision 8 by drive type.** A user-mode file system backed by network or cloud storage that reports itself fixed (WinFsp and rclone by default) or removable (Dokan, optionally) is admitted, as TypeScript admits it after realpath.

**Independent review.** A read-only filesystem-security reviewer (Opus, high effort from the security agent's definition, below the xhigh owner) reviewed the sealed tree `c43e2af` (tree `ed7deec`). It returned **GO**: no critical, high or medium finding. In its own export it built with `-warnaserror` and passed 17 of 17 platform drive tests, 43 of 43 call-site tests (none skipped) and 179 of 179 removable-drive replays and tests. It read both mutation logs and judged the replays real differential evidence, because undoing the folder or Git lease admission fails them. Its findings:
- **L1 (low), fixed.** A Git pointer naming a drive root (`gitdir: D:/`) was probed before its drive type was refused, because a root has no parent to pin first. The comment claimed otherwise. `PinnedDirectory` now refuses every type a project may not sit on before any open, as `RepositoryFolderLease` does. The fake cannot register a drive root, so no test observes the order; the messages are the same either way.
- **L2 (low), fixed.** The FAT and exFAT gap reaches the project channel and the retry as well as `project.add`; the difference above now names them.
- **I1, I2 and I3 (informational).** Recorded above: the "No disk" prompt, the evidence scope of the mutation check, and decision 8 by drive type.

After the L1 fix the Release build was again clean, and the full native suite again passed **8,177, with zero failures and the same two skips** (`build-release-review-fix.log`, `dotnet-test-review-fix.log`). TypeScript is unchanged, so the third `pnpm check` run still applies.

The same reviewer **confirmed** the delta `c43e2af..033f160`, with no new finding above informational. In its own export it passed the Release build, 17 platform drive tests, 43 call-site tests, 103 Git identity tests and 179 removable-drive replays and tests. It found that the L1 change refuses nothing that was admitted before: on a real drive, a reference and its parent always share a type. Its one wording point, on the mutation check's evidence scope, is applied above.

**Local validation of the final source and tests.**
- Release build with `-warnaserror`: **zero warnings or errors**.
- Full native suite: **8,177 passed, zero failed, two skipped (8,179 total)**. The skips are the expected file-symbolic-link test and the local registry-policy (WebView2 lockdown) test.
- `pnpm check`: TypeScript is unchanged. Two full runs each failed one test, `publish.test.ts`'s push case, at 36 and 37 seconds against its 30-second timeout; the first ran beside the mutation check. That load-sensitive test has timed out in earlier sessions too (P2.3c, P2.4b). The file then passed alone, 18 of 18, and a third full run passed type checking, lint and **596 tests across 96 files**.
- No renderer, IPC, user-path or packaging source changed, and the native runtime is not in the shipping package, so neither `pnpm test:e2e` nor the package smoke was required.
- `git diff --check`: clean.
- Logs: `build-release.log`, `dotnet-test.log`, `pnpm-check*.log` and `pnpm-publish-alone.log` in `foundry-evidence\removable-project-drives`.

## Personal workspace expansion — local implementation

Recorded 27 September 2026. The [six-stage expansion contract](personal-workspace-expansion.md) extends the [product baseline](foundry-agent-workspace-plan.html). All six stages are implemented on `codex/personal-workspace-expansion`, integrated with main's saved projects, usage analytics, browser workflows and portable packaging. No installation or live-provider qualification is implied.

| Stage | Delivered behavior | Principal evidence |
| --- | --- | --- |
| 0 | Shared coordinator transcript; canonical MCP configuration with safe status/edit types and verified repair; accessible inspector drawer; explicit documentation screenshot command | Coordinator restart and keyboard approval at 200% zoom, MCP rejection/repair/canary and large-server regressions |
| 1 | Inbox, Recent, All tasks, Archived; root-group archive independent of execution; FTS search; bounded stable task/message/action pages and complete chunks | 1,000-task/100,000-message fixtures, concurrent/escaped paging, archived pending child recovery, Inbox failure behavior |
| 2 | Recorded activity, SVG dependency/usage views with accessible alternatives, recovery links, opt-in generic native notifications | Authoritative event/record mappings, unknown-usage separation, notification sender/content tests |
| 3 | Local task templates; typed lifecycle rules and inert drafts; pinned PowerShell/JavaScript revisions, revocable grants and supervised execution | No-grant/expired/changed-pin cases, renewal/revocation races, unknown restart, output limits, Windows child cleanup and split UTF-8, fresh ordinary approval for action drafts |
| 4 | Decision history, cited continuation context and exact source revisions, safe local previews, Markdown/JSON/checksum export | Independent authority, unknown/dirty-source rejection, path/signature/size checks, escaped preview bounds, export snapshot consistency and interruption cleanup |
| 5 | App-open one-time/daily/weekly reminders and prompt drafts, editable task/zone/date/weekday settings, archived-task reminders | DST gap/fold, activation boundary, UTC occurrence retention, timezone revisions, missed-occurrence coalescing and no automatic model turn |

The runtime remains the sole application-data writer and execution authority; Chromium owns its isolated browser-profile databases. Integrated schema v5 follows the saved-projects v3 and usage v4 migrations. Existing v1–v4 databases require explicit confirmation and a verified WAL-aware backup. Migration/index/FK failure rolls back inside the transaction. Existing unsafe MCP configuration is logically quarantined; retained backups and historical filesystem bytes are not claimed to be erased.

Integration preserves draft-first task creation and exact profile credential binding. Browser cancellation and retirement invalidate attachments even while eligibility reads are pending; stale transport callbacks cannot tear down a replacement runtime. Paged usage and trend queries now use the canonical provider-request ledger, count migrated records once, include coordinator children, and distinguish observed tokens, pending reservations, unknown usage and requests not sent. Independent security review found no remaining blocker in these boundaries.

Archive, hook and scheduling admission can be paused persistently while retaining history and recovery. The reusable script grant is an explicit new permission class: scripts run with Windows user privileges, and a pinned entry file does not pin imported code or external effects. Script-produced application actions still require a new review and one-shot approval. Schedules only produce reminders/drafts; the user presses Send.

Independent review used three GPT-6 Sol / medium specialists under the Critical owner, selected by the working agreements and workflow-router. Runtime/data review covered schema, paging, source verification and export consistency. Product/UI covered navigation, accessibility, bounded rendering and restart journeys. Security/QA reviewed credentials, MCP, IPC, script grants, dispatch races and process cleanup. The owner retained service integration and final verification. Concrete findings were fixed and tested, including queued grant renewal, oversized config responses, UTF-8/pipe handling, and source-lock validation order.

| Specialist | Model / effort | Selection source | Routing reason |
| --- | --- | --- | --- |
| Architecture and runtime (`architecture_audit`) | GPT-6 Sol / medium | Working agreements and workflow-router | Bounded data/query work and independent migration, upgrade-admission and script-launcher review |
| Desktop UX (`product_ux_roundtable`) | GPT-6 Sol / medium | Working agreements and workflow-router | Navigation, transcript presentation, accessible dialogs and desktop regression journeys |
| Security and QA (`security_audit`) | GPT-6 Sol / medium | Working agreements and workflow-router | Trust boundaries, negative tests, process supervision and independent review of runtime/data changes |

The owner independently reviewed the runtime supervisor pipe-failure change. The final PowerShell launcher received independent architecture review and a separate real-Windows run of its 35-test automation suite; both passed. Final desktop review also closed native-dialog focus wrapping and nested close-event bubbling; the 200% grant test verifies natural keyboard traversal, viewport visibility and preservation of the outer settings dialog. These reviews supplement the integrated gates below.

### Expansion verification before main integration

| Boundary | Passing evidence | Scope |
| --- | --- | --- |
| Types, lint and automated tests | `pnpm check --maxWorkers=1 --hookTimeout=60000`: **33 files, 329 tests passed** in 523.63 seconds, clean typecheck and lint | Final application and test-harness files; v1/v2 upgrades and failure rollback, MCP quarantine/canaries, 1,000 tasks and 100,000 messages, bounded/escaped queries, script authority/races/cleanup, continuity/export, schedules and desktop transport failures |
| Desktop user paths | `pnpm test:e2e`: **13 passed (2.5m)** | Coordinator history and completion/restart, archived child approvals through Inbox, action-query failure, v1 upgrade, native 200% approval/grant keyboard paths, nested-dialog close preservation, reminders, compaction, MCP, reviewed editing and commands |
| Packaged build | `pnpm package:dir`: **PASS** | Final Windows x64 unpacked build at `release/win-unpacked/Foundry Agent Workspace.exe`, with the unpacked Job Object helper and native SQLite dependency |
| Packaged runtime | `pnpm smoke:package`: **PASS** | SQLite v3; 14 bound coordinated approvals, 3 serial integrations and exact-tree validation; archive obligations, fresh continuation and checksummed export; Unicode PowerShell/JavaScript hooks, pinned-source review, changed/untrusted revisions, malformed/oversized output, revocation and descendant cleanup; archived reminders and forced runtime crash recovered as unknown without replay |

Final logs are retained under `.local/verification/personal-workspace/`: `check-complete.log`, `e2e-release-qualified.log`, `package-qualified.log`, and `smoke-final-qualified.log`. The packaged executable and smoke assertions were unchanged by the subsequent test-harness error-reporting-only cleanup; the final full check covers that cleanup. Earlier failed diagnostic logs remain separate and are not passing evidence.

The same directory retains `script-grant-200-percent.png` (native Electron capture), `usage-chart.png`, and `orchestration-complete.png`, all visually inspected. Routine renderer screenshots remain in ignored `test-results/`; updating documentation images requires the separate `pnpm docs:screenshots` command, which was not run. The source/diff check is clean, and first-party application, script and test searches found no remaining `workspace.snapshot` or `task.get` RPC callers.

Live Azure model qualification, clean Windows installation, publisher signing and external distribution remain separate gates. `Get-AuthenticodeSignature` reports the unpacked executable as **NotSigned**. Native Windows toast delivery was not manually qualified; automated coverage verifies preference, sender and safe notification-content behavior. No production/user data was migrated by this implementation task. Tests use isolated repositories, databases and injected providers.

One failed-smoke fixture remains at `C:\Users\rdpro\AppData\Local\Temp\foundry-package-smoke-TIjYKj`. Its runtime was terminated; a later explicit cleanup was rejected by the command policy with "blocked by policy," so no alternate deletion route was attempted. This directory contains isolated test data, not application/user data.
### Integrated validation after main synchronization

The final integrated source passed `pnpm check --maxWorkers=2 --hookTimeout=60000`: **43 files, 423 tests**, clean typecheck and lint (404.66 seconds). `pnpm test:e2e` passed **21 tests (3.6 minutes)**, including saved projects, browser actions, canonical usage, coordinator restart, archived approvals and keyboard operation at 200% zoom. Independent review cleared the canonical usage queries and cancellation/transport race fixes.

Logs: `.local/verification/personal-workspace/integration-check-final.log` and `integration-e2e-qualified.log`. The screenshots prefixed `integration-` in that directory preserve the grant, coordinator and usage views. Later smoke-harness-only edits update two schema-version assertions from v3 to v5 and wait for the queued-to-cancelled revocation transition while rejecting any dispatch. Scoped ESLint passed; independent review confirmed the timing boundary, and the packaged smoke run directly validates those assertions.

`pnpm package:dir` and `pnpm smoke:package` passed against the integrated application. Packaged evidence covers schema v5, saved projects, idempotent draft starts, canonical usage, 14 bound coordinator approvals, 3 integrations, MCP, continuation/export, archived reminders, script limits/revocation/process cleanup and crash recovery without replay. Logs: `integration-package.log` and `integration-smoke-package-final.log`. Earlier diagnostic failures are retained separately and superseded by this passing run.

`pnpm package:portable` and `pnpm smoke:portable` also passed; the portable executable extracts and starts bundled Electron 44.4.1 with functioning SQLite. Logs: `integration-portable-build.log` and `integration-portable-smoke.log`. Portable SHA-256: `805906f7e35e758a77786ee417e021aa358b5b9f5a225345d788f92b588ae1b4`; packaged `app.asar` SHA-256: `3956803d55a98b9f4ff86eaa1db2283a830421cce4e9f1fb1449a2196c645aef`. The portable executable is **NotSigned**. These local results do not assert a published release, clean installation or live Azure qualification.

## Saved projects and draft-first chat creation — 27 September 2026

Local implementation on `codex/saved-projects-sidebar` in the [Foundry Agent Workspace source](https://github.com/koala-man-64/foundry-agent-workspace). Publication, installed application upgrades, and live provider qualification are separate gates.

- The sidebar now groups chats under saved projects, with compact status dots, alphabetical project ordering, recent chat ordering, and a final **No folder** group. Project menus and **Manage projects** support rename, hide, and restore. Hiding retains chats and files; collapsed groups persist. Settings and diagnostics are in the footer.
- **New chat** and project **+** controls open session drafts in the main area. Switching projects preserves drafts, and background refreshes do not replace them. The first send creates the chat; an omitted title comes from the first message's first line, limited to 80 characters. Model and Git mode preferences persist app-wide; ordinary-folder and projectless drafts use Chat without changing the remembered Git mode.
- Saved projects use stable IDs and canonical paths. Folder registration uses the native picker and runtime validation. Missing folders stay listed as unavailable. Task workspace kinds distinguish Git worktrees, ordinary folders, and no folder; the runtime enforces the same capabilities as the inspector. Ordinary-folder browsing retains containment, symlink, secret-file, and size checks. Coding, coordination, worktree operations, and Git publication require Git workspaces.
- `task.start` binds a client request ID to the first message and settings. Durable reservation precedes workspace creation and dispatch. Completed retries return the existing task; unknown outcomes retain their evidence and do not replay automatically. The renderer retains failed drafts and their original request. Existing task-creation callers remain supported and their successful creations associate with saved projects.
- Schema v3 adds projects, preferences, and first-send records. Existing v1/v2 databases remain readable until the user confirms the existing verified-backup upgrade flow. Migration groups legacy tasks by project path and preserves task IDs, history, and coordinator/child relationships.

Validated locally using temporary folders, fresh application data, and offline providers:

- `pnpm check`: typecheck and lint passed; 256 tests passed across 24 files after integrating the project channel.
- `pnpm test:e2e`: all 11 Electron workflows passed, including coordinated draft first-send, saved ordinary folders, Git projects, No folder, confirmed v1 upgrade, restart history, keyboard navigation, and the narrow layout. Background task events preserve another project's draft. Git chats retain the project channel; folder and projectless chats cannot access it.
- The initial integrated Electron run exposed an approval test helper that silently stopped waiting before the next approval arrived. The helper now waits for completion or a pending approval and binds its evidence, click, and state check to one stable approval ID. Independent review found no remaining issue; typecheck and scoped lint passed.
- `pnpm package:dir` and `pnpm smoke:package`: passed. The packaged runtime verified schema v3, idempotent folder/projectless first-send, saved-project management, reviewed coding tools, coordination, compaction, MCP, diagnostics, and safe Git retirement against isolated fixtures.
- Independent GPT-6 Sol/medium review of filesystem, IPC, persistence, concurrency, and draft boundaries found no remaining actionable defects after fixes. Three GPT-6 Sol/medium agents handled runtime implementation, renderer implementation, and independent review under the supplied AGENTS.md Critical lane.

The final stable-ID coordinator Electron rerun passed (1.7 minutes). Packaging and packaged smoke passed again after integration. Exact command logs and review evidence are retained under `.local/validation/saved-projects-*` and `.local/validation/delivery-*`. Packaged `release/win-unpacked/resources/app.asar` SHA-256: `1f8e1f9d4cadeeb857700a687195142c0cadad7056043ccdfed803cd2b59fd21`.

This is a local source and unpacked-package result. No user's application database was upgraded. External publication, installed/signed installer validation, live Foundry qualification, and live deployment remain unverified and outside this change's execution.

## Project channel — local implementation

Recorded 27 September 2026. Agents in separate task chats and coordinator teams can discover teammates, broadcast project messages, and send direct messages. The runtime derives membership from the canonical local Git common directory, including linked worktrees. Independent clones stay separate. The inspector exposes **Project channel**, a participant list, paginated retained history, and a user-labelled message composer.

The protocol validates every request. Sender identity comes from the active runtime task; messages cannot supply authority, widen assignments or approve actions. Cancelled/terminal coordinated agents and retired tasks cannot send. Secret-screened messages have byte and per-task count limits. Communication-only tools are available to capable chat profiles without enabling repository tools; text-only profiles can receive pending context. Coding and coordinated agents retain their existing action gates.

Messages and per-recipient delivery cursors use existing events, with an incremental runtime metadata index and primary-key body reads. No schema upgrade is added. Delivery occurs on the next model request, including native tool continuation, and never wakes an idle agent. Cursors advance with successful provider-state persistence; a failed request leaves messages pending. Serialized delivery is bounded and explicitly marks truncated text, while history retains the full message. Real native chat histories also participate in compaction and pending messages are included in usage estimates.

Independent review used GPT-6 Sol at medium effort, selected by the project working agreements for IPC, persistence and concurrency risk. Review findings on event-scan cost, linked-worktree identity, and escaped-message bounds were fixed with regressions; the final channel and compaction review found no remaining blocker.

Validation completed locally against isolated fixtures:

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Types, lint and automated tests | `pnpm check --maxWorkers=1 --hookTimeout=60000`: **23 files, 242 tests passed**, clean typecheck and lint | Includes 9 channel unit tests, 4 channel integration tests, native chat/coding compaction, and existing approval/coordinator coverage. One worker and a 60-second fixture setup limit accommodate slow Windows Git setup; application timeouts and safety assertions are unchanged. |
| Desktop user paths | `pnpm test:e2e`: **8 passed (3.2m)** | Agent broadcast, user direct message, recipient isolation, idle-agent behavior, retained visible history, and existing desktop workflows. After the final CSS-only contrast adjustment, `pnpm exec playwright test tests/e2e/agent-channel.spec.ts` passed again (6.4s), and the screenshot was visually inspected. |
| Packaged build | `pnpm package:dir`: **PASS** | Final Windows unpacked build at `release/win-unpacked/Foundry Agent Workspace.exe`, including the final styling. |
| Packaged runtime | `pnpm smoke:package`: **PASS** | SQLite v2, approved editing/commands, 14 bound coordinated approvals, 3 serial integrations, compaction, MCP, diagnostics and clean fixture retirement through the packaged executable. |

Exact logs and the final channel screenshot are retained locally under `.local/verification/agent-channel/`: `check-serial.log`, `e2e.log`, `channel-ui-final.log`, `package.log`, `smoke.log`, and `agent-channel.png`. Earlier failed diagnostics are also retained; their results do not replace the passing evidence above. The package smoke verifies runtime compatibility; the dedicated channel tests supply messaging behavior evidence. Live paid-provider messaging, installer installation and external publication are unverified. No dependency or database schema change was required.

## Built-in usage analytics — 27 September 2026

Implemented locally: a Usage overview with local-calendar date ranges, daily measured tokens, conversation/model/effort/profile/API comparisons, request drilldowns, child attribution, and separately labelled profile checks. Offline demo requests are excluded by default. Cached input and reported reasoning are subsets of input/output; missing breakdowns remain unavailable. Reservations and unreported consumption are distinct from measured tokens.

Model profiles now support optional requested-effort presets. The native provider parameter is sent on each request and included in verification identity. Existing default profiles keep their fingerprints. Explicit-effort connection checks use the configured output allowance and disclose up to four requests; routine tests use injected providers.

Schema v4 adds one canonical request ledger after the saved-projects v3 migration. Admission and budget reservation are transactional, as are terminal accounting and budget settlement. Final provider usage can be retained for failed/cancelled requests without executing their tools. Restart recovery retains original request identities and never retries inference. Existing v1/v2/v3 data is upgraded only through the explicit verified-backup action; historical attribution/outcome remains unknown where it was not recorded, and original usage rows are retained. Existing v2 orchestration and v3 saved projects remain available before upgrading.

Initial validation completed on Windows on 27 September 2026, before integration with the project-channel increment, using isolated application data and injected/offline providers:

| Gate | Result | Local evidence |
| --- | --- | --- |
| `pnpm check --maxWorkers=2` | Type checking, lint, and **266 tests in 25 files passed** | `usage-check-final.log` |
| `pnpm test:e2e` | **10 tests passed**, including v1 upgrade, Usage filters, partial metrics, pagination, child navigation, and effort choices | `usage-e2e-final.log`; `test-results/usage-seeded-overview.png` |
| `pnpm package:dir` | Windows application directory built successfully | `usage-package-dir.log`; `release/win-unpacked` |
| `pnpm smoke:package` | Packaged schema v3, usage RPCs/pagination, coding, orchestration, MCP, compaction, publication, and retirement checks passed | `usage-smoke-final.log` |
| Independent implementation review | Provider, accounting/persistence, IPC/runtime integration, and UI reviews completed; findings resolved and rechecked | Specialists `usage_provider_impl`, `usage_ledger_impl`, and `usage_accounting_review`: GPT-6 Sol, medium, selected under the AGENTS.md Critical lane |

The first unconstrained check was interrupted after widespread timing failures; the final run used two workers. Effort choices were checked against current [Azure reasoning guidance](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning) and [Anthropic effort guidance](https://platform.claude.com/docs/en/build-with-claude/effort); Azure `max` is offered only for Responses, and deployment-specific support still requires connection verification. Test-generated documentation screenshots are retained. Local evidence logs and test-result images are ignored build artifacts, not external publication evidence.

Delivery integration preserves the [project-channel changes](https://github.com/koala-man-64/foundry-agent-workspace/commit/2b42bb7c5ac99d8a520df8fa9bbd310e83a0acbd) and the later [saved-projects changes](https://github.com/koala-man-64/foundry-agent-workspace/commit/cdec0a376b31f8bab1815953828b5a8002ab5944). Channel acknowledgement and usage settlement remain transactional; each channel-tool continuation has a separate request identity. The upgrade guard allows read-only channel queries and blocks channel sends. Saved projects retain schema v3, while usage becomes v4; folder and projectless first-send requests are measured once, including idempotent retries. Independent GPT-6 Sol/medium review confirmed runtime and migration boundaries after integration.

Validation before the saved-projects integration for [PR #7](https://github.com/koala-man-64/foundry-agent-workspace/pull/7): `pnpm check --maxWorkers=2 --hookTimeout=60000 --testTimeout=60000` passed type checking, lint, and **282 tests in 27 files**. All **11 desktop tests**, the Windows package build, and packaged smoke also passed. A previous run reached 281 passing tests but timed out during the existing forged-provenance Git fixture and then encountered a cleanup lock; the final run used a 60-second test allowance without changing application timeouts or assertions. Delivery logs are `usage-delivery-check.log`, `usage-delivery-e2e.log`, `usage-delivery-package.log`, and `usage-delivery-smoke.log`.

Final saved-projects integration validation: the full `pnpm check --maxWorkers=2 --hookTimeout=60000 --testTimeout=60000` passed type checking, lint, and 299 of 300 tests across 28 files. Its sole failure was the upstream unsupported-future-schema fixture still using version 4. After updating that test-only fixture to version 5, `pnpm check packages/runtime/tests/orchestration-store.test.ts --maxWorkers=1 --hookTimeout=60000 --testTimeout=60000` passed type checking, lint, and all 17 affected tests. No application code changed after the full run; these results cover all 300 tests. `pnpm test:e2e` passed all 14 tests, and the rendered Usage page was visually inspected with the saved-projects sidebar. `pnpm package:dir` and `pnpm smoke:package` passed with schema v4, saved projects, projectless/folder first-send chats, and usage summaries/breakdowns/pagination. Exact logs: `usage-main-check.log`, `usage-main-schema-check.log`, `usage-main-e2e.log`, `usage-main-package.log`, and `usage-main-smoke.log`.

Live provider qualification and application installation have not been performed for this increment. No existing user database was upgraded. Durable coordination registration was unavailable (`session_token_unavailable` / installation mismatch); implementation used disjoint file ownership in a private task worktree and has no registered claims to release.

## Portable Windows build automation — 27 September 2026

Hosted qualification follow-up: Windows aliases exposed an MCP containment gap. Validation now compares both authored and canonical paths, resolves existing ancestors for missing paths, and fails closed when inspection fails. Browser resizing now uses available workspace geometry, hides native content during dragging, and releases capture on cancellation or blur. Expanded mode hides the resize handle and remains visible on narrow windows. Project fixtures compare canonical paths.

The [timed hosted diagnostic](https://github.com/koala-man-64/foundry-agent-workspace/actions/runs/36339163356) measured 32.3 seconds before the MCP fixture started, followed by an immediate reply after the former 30-second initialization deadline. Initialization now has a bounded 60-second allowance; listing and configured tool-call deadlines are unchanged. The command helper watchdog separately allows 60 seconds for startup while its native command execution deadline remains unchanged. Both Windows helpers check cancellation before process creation and resume. Actual-helper regressions prove that pre-cancelled launches do not execute user code. Numeric transport diagnostics retain no protocol content. The slow phase within Windows host preparation has not been isolated.

The follow-up passed independent GPT-6 Sol/medium review under the project's Critical policy, focused helper and process-tree regressions, typecheck and scoped lint, `pnpm package:dir`, and `pnpm smoke:package`. The [hosted qualification run](https://github.com/koala-man-64/foundry-agent-workspace/actions/runs/36339879307) passed typecheck, lint, all **325 tests across 32 files**, all **16 Electron workflows**, the portable build, both packaged-runtime and portable-launcher smoke tests, and artifact/checksum upload. Earlier evidence below describes its respective source revision; signed distribution, live providers, and interactive use on a fresh machine remain separate qualification gates.

The final `pnpm smoke:package` also passed: packaged schema v4, folder/projectless first-send, saved projects, usage summaries, reviewed coding operations, 14 coordinated approvals, compaction, MCP, sanitized diagnostics, and safe Git retirement all ran against isolated fixtures.

Final integration verification after combining the browser with saved projects, the project channel, and usage analytics: `pnpm check --maxWorkers=1` passed **32 files / 320 tests** (540.32 seconds), including typecheck and lint; `pnpm test:e2e` passed **16 tests** (2.7 minutes). The narrow-window regression is covered by retaining New chat navigation while hiding native browser content. Both `pnpm package:dir` and `pnpm package:portable` passed. `pnpm smoke:portable` passed against the actual Windows x64 EXE, including bundled Electron 44.4.1 and SQLite. The smoke script's final diagnostic change also passed scoped ESLint and independent GPT-6 Sol/medium review. The first combined check exposed one stale denial-message assertion and Windows Git-fixture timeouts; the final run passed without extending timeouts. Logs are retained locally under `.local/browser-verification/merge-*`.

The `Portable Windows build` workflow runs for every push to `main` without path filters and can also be started manually. A Windows x64 runner installs the frozen lockfile and pinned Electron runtime, runs `pnpm check --maxWorkers=1` and offline Electron E2E tests, builds `pnpm package:portable`, and smoke-tests the packaged runtime and portable launcher before uploading the portable EXE and its SHA-256 checksum. The launcher check exercises extraction and bundled Electron/SQLite with an isolated temporary directory; it does not qualify interactive use on a fresh machine. Tests use one worker to reduce Windows process contention. Artifacts expire after 30 days. Actions are pinned to verified commit SHAs, checkout does not retain credentials, and the workflow token has only `contents: read` permission.

The portable build needs no installer or Node.js/pnpm on the destination machine. Git remains necessary for repository tasks. Application data and browser sessions remain per Windows user, rather than beside the EXE. Signing, automatic updates, and GitHub Release publication are not configured. The matching GitHub Actions run and its uploaded artifact are authoritative for hosted build success; local validation alone does not establish it.

Local verification: actionlint 1.7.12 passed; `pnpm check --maxWorkers=1` passed all **25 files / 248 tests** (721.35 seconds), including typecheck and lint; `pnpm test:e2e` passed **9 tests** (3.3 minutes); `pnpm package:dir`, `pnpm package:portable`, and `pnpm smoke:package` passed. The generated portable EXE's SHA-256 checksum was independently verified. The initial parallel test run timed out in one Git fixture (247 passed); the final single-worker command passed the entire suite without changing test limits. Exact logs are retained locally under `.local/browser-verification/ci-*` and are not committed.

## Integrated browser — 27 September 2026

Local implementation adds the resizable Browser inspector, managed tabs, expansion, navigation controls, and one app-owned Chromium profile shared across projects. Cookies and website storage live under `userData/browser-data` (including the isolated test-data override). Restart begins with one blank tab; there is no application browsing-history database or saved tab list. Confirmed site/profile clearing touches browser storage only.

Website views use sandboxed `WebContentsView` without Node, preload, or an application bridge. The main process owns lifecycle, profile, navigation policy, native dialogs, and bounded CDP operations; the runtime retains sole ownership of application SQLite. No production dependency or separate browser installation was added. Permission requests default to denied, certificate errors are not bypassed, and only HTTP/HTTPS navigation is accepted.

Explicit attachment shares a bounded visible-page snapshot with that chat's configured model. Ordinary chats receive browser tools without repository tools; coding tasks also use the native continuation path. Every interaction uses an existing persisted approval record bound to chat, tab, attachment, origin, document generation, snapshot target, and exact arguments. Navigation or takeover invalidates pending actions; origin changes suspend reads. Dispatch failures with uncertain results remain unknown, are never replayed automatically, and have a browser-specific inspection acknowledgment that does not relax filesystem or external-tool recovery.

File selection and download destinations are manual. Attachment refuses pages with selected files and blocks input/navigation during the attachment scan. Agent tools expose no chooser, filesystem, cookie, storage, raw CDP, or arbitrary JavaScript access. Attached views block downloads and common direct file-transfer request bodies. This is not a general data-loss-prevention boundary: website JavaScript can still send data it already holds using ordinary network requests. Password fields and hidden form values are excluded from snapshots; websites and page instructions remain untrusted.

Independent GPT-6 Sol/medium review found no remaining concrete security blocker after fixes for focus-redirection during key actions, selected-file inheritance and attachment races, origin handling, popup adoption/self-close, and shutdown cleanup. All four bounded agents used GPT-6 Sol/medium, selected under the project's Critical lane: `browser_controller` owned the native host and lifecycle; `browser_runtime` owned persisted approvals and native continuations; `browser_ui` owned controls and bounds synchronization; `browser_security_plan_review` independently reviewed IPC, persistence, and concurrency. Final integration and validation were performed by the owner.

| Evidence | Result | Scope |
| --- | --- | --- |
| `pnpm check --maxWorkers=1` | **25 files / 248 tests passed**, typecheck and lint passed | Full suite, serialized to reduce concurrent host load. Final typecheck/lint also cover the subsequent popup lifecycle, coordinated-inspector layout, and fixture changes. |
| Focused browser suites | **4 files / 19 tests passed** | Protocol validation, ordinary-chat tool isolation, durable approvals and unknown acknowledgment, target staleness, one-shot concurrent dispatch, redirect suspension, takeover/crash/detachment, selected-file rejection, popup adoption/self-close, address normalization. |
| `pnpm test:e2e` | **9 passed** | Browser storage restart (persistent cookie, local storage, IndexedDB), blank startup, native view isolation, expansion/dialog hiding, managed popup login/self-close, site/profile clearing, ordinary-chat approved action, secret canaries, takeover and destination-controlled download; existing coordinated, coding, MCP, and history routes remain passing. |
| Expanded browser E2E rerun | **2 passed** | Added real file-chooser selection and multipart upload to the isolated local server, including attachment refusal while the file was selected. |
| `pnpm package:dir` | **Passed** | Unpacked Windows application built successfully with existing dependencies. |
| `pnpm smoke:package` | **Passed** | Packaged runtime/SQLite, approved coding edit and command, coordinated workflow (14 bound approvals), compaction, MCP host, diagnostics, and safe retirement. Runtime-only fixture explicitly responds to the private browser channel with no attached tabs. |

Exact logs are retained under `.local/browser-verification/`: `check.log`, `browser-unit.log`, `e2e-final.log`, `browser-e2e.log`, `typecheck-final.log`, `lint-final.log`, `package.log`, and `smoke.log`. Earlier failures exposed fixture synchronization gaps, popup lifecycle defects, and a five-pixel coordinated inspector caused by the new resize column; the final runs above include their fixes. Tests use isolated data and local fixtures with no paid provider probes.

These results establish local source, desktop user-path, and packaged-runtime evidence. The pull request and matching GitHub Actions run separately establish main-branch integration and hosted artifact delivery. Real provider/browser combinations, third-party identity-provider policies, clean-profile installation, and signing remain separate release gates. Browser extensions, multiple profiles, password management, and system-browser imports remain out of scope. File chooser automation and save-dialog destination injection qualify application behavior; human interaction with the platform-native save dialog remains a manual release check.

## Phase 05 — Independent review and Windows release

Recorded 19 September 2026 (America/Chicago) on branch `main`. Delivered via parallel multi-agent workstreams:
- **Workstream A (Security, IPC & Canary Hardening)**: Claude Opus 5 (`c642667`)
- **Workstream B (Live Deployment Qualification Framework)**: Claude Sonnet (`f2e6533`)
- **Workstream C (Packaging & Clean Installer)**: Claude Sonnet (`1c05b87`)
- **Workstream D (Disaster Recovery & Operational Runbook)**: Antigravity (`c0d1352`)
All four workstreams merged into `main` with zero conflicts and full automated test, packaging, and smoke verification.

### Delivered

- **IPC sender origin & subframe security hardening.** `authorize(event)` in `apps/desktop/src/main/index.ts` validates that IPC requests originate strictly from the main frame on the expected scheme (`file:` in packaged builds, `http:` on localhost in development). Because `URL.origin` evaluates to the string `"null"` for `file:` and non-special schemes, the gate now compares protocols explicitly and fails closed with `'Untrusted IPC origin.'` if the scheme differs, preventing foreign-scheme frame spoofing. Unparsable URLs fail closed cleanly.
- **JSON-escaped credential canary screening.** `Redactor.add` in `packages/runtime/src/redaction.ts` registers bounded JSON encoding levels of known credentials (including escaped quotes, backslashes, and newlines). Tests verify the specified canaries and surfaces. Pattern screening also detects some bearer tokens and private keys; it is not a universal secret detector, and logical repair does not erase historical WAL pages or backups.
- **Product-wide security audit suite.** `tests/integration/security-audit.test.ts` (734 lines) provides comprehensive automated regression testing across 4 critical security boundaries: IPC frame sender origin verification (stand-in Electron module exercising real handlers with forged senders and subframes), Windows path containment (asserting rejection of UNC paths `\\.\`, `\\?\`, NTFS Alternate Data Streams `:stream`, 8.3 short-name aliases, trailing dots/spaces, and junction traversal), synthetic secret canary leak matrices, and Windows Job Object descendant termination.
- **Standalone Azure Foundry deployment qualification CLI.** `scripts/qualify-deployments.mjs` (769 lines) executes the full 5-point qualification protocol against live or mock Azure Foundry endpoints across all three supported API kinds (`responses`, `chat-completions`, `anthropic`): (1) streaming text & time-to-first-token latency, (2) native tool-call generation and schema parsing, (3) tool continuation with opaque reasoning / signature preservation, (4) mid-stream cancellation via `AbortController`, and (5) token burndown & cache accounting. Includes `--mock` flag for 100% offline testing without live network calls, TypeScript definitions (`scripts/qualify-deployments.d.mts`), automated Vitest coverage in `packages/providers/tests/qualification.test.ts`, and reference schema `docs/qualification-template.json`.
- **Windows clean-profile installer auditor.** `scripts/verify-clean-install.ps1` (232 lines) audits the production NSIS package: validates executable presence and size, captures Authenticode signature status via `Get-AuthenticodeSignature`, verifies unpack configuration and unpacked helper scripts (`mcp-host.ps1`, `job-runner.ps1`, native `.node` binaries), verifies non-elevated per-user installation target (`%LOCALAPPDATA%\Programs\Foundry Agent Workspace`), verifies application data segregation (`%LOCALAPPDATA%\FoundryAgentWorkspace`), and confirms safe uninstallation scope (preserves user project repositories and worktrees).
- **Code signing and distribution documentation.** `docs/signing-and-distribution.md` provides comprehensive guidance on Authenticode signing options (unsigned developer builds with SmartScreen instructions, self-signed test certificates, and enterprise Azure Trusted Signing configuration), per-user non-elevated installation, and data retention policies.
- **Disaster recovery runbook.** `docs/recovery.md` documents operational procedures for: read-only reconciliation of unknown commit, push, and worktree retirement intents; SQLite database integrity verification (`PRAGMA integrity_check`) and WAL checkpointing; rolling back schema upgrades from automatic `.bak` backups; resolving and adopting coordinator cherry-pick merge conflicts in external editors; and rotating credentials in Electron `safeStorage`. *Superseded 16 October 2026:* an audit against the code found wrong RPC names, file names and controls, plus unsafe steps (discarding changes, removing worktrees by hand, checkpointing the live WAL, restoring by copy). The runbook was rewritten.
- **Release evidence matrix.** `docs/release-evidence.md` tabulates all 9 release acceptance criteria from Section 07 of the plan against exact automated test suites, commit citations, and verification artifacts. *Corrected 16 October 2026:* criteria 1 and 9 are open, and 4 is partly met; the earlier statuses overstated offline evidence.

### Validation

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Types, lint, tests | `pnpm check`: **21 files, 228 tests passed (clean typecheck and lint)** | Prior 192 tests plus security audit suite (26 tests in `security-audit.test.ts`) and qualification suite (5 tests in `qualification.test.ts`). Zero failures. |
| Live deployment qualification | `node scripts/qualify-deployments.mjs --mock`: **PASS** | 5-point qualification protocol passes offline for streaming, toolCalling, toolContinuation, cancellation, and usageAccounting. |
| Packaged runtime | `pnpm package:dir` & `pnpm smoke:package`: **PASS** | Built `release/win-unpacked`. Packaged Electron/SQLite v2 runtime: coding and coordinated workflows, 14 bound approvals, 3 cherry-picks, compaction, MCP demo via unpacked Job Object host, diagnostics export, and clean worktree retirement. |
| Production installer | `pnpm package:win`: **PASS** | Built `release/Foundry Agent Workspace Setup 0.2.0.exe` (115.63 MB) and blockmap. |
| Clean installer audit | `powershell -File scripts/verify-clean-install.ps1`: **PASS** | 6 passed, 1 expected signature warning (unsigned candidate), 0 failed. Verifies artifact presence, unpack manifest, path containment, and uninstall safety. |
| Desktop user paths | `pnpm test:e2e`: **7 passed (2.7m)** | Chat, Coding, coordinated workflows, scoped cancellation, IPC forgery rejection, legacy v1 database upgrade, compaction, MCP approval, diagnostics export, and worktree retirement. |
| Independent review | Completed across all 4 workstreams; all security and qualification findings addressed on `main`. | Independent review by Claude Opus 5 on security/IPC and Claude Sonnet on qualification/packaging. |

---

## Phase 04 — Context and external tools

Recorded 18 September 2026 (America/Chicago) on branch `agent/claude/phase-04-context-and-tools`, merged to `main` at `db08e16`. Owner: Claude (Fable 5.1) as Lead Systems Engineer under Antigravity's assignment in `TASK_PHASE_04.md`.

### Delivered

- **Controlled compaction.** `task.compact` (header and Usage-panel button) summarizes older complete turns into a runtime-generated, bounded, secret-screened structured summary that is labelled as data and never produced by a model or from repository text. The summarized range, message ids, estimates before/after and the provider state before/after are retained in the additive `compactions` table; the original messages are never deleted and the transcript keeps them dimmed beneath the summary. Provider-native continuation is compacted shape by shape (Responses `input`, Chat Completions `messages`, Anthropic `messages` + `system`): the cut is placed only at a plain user turn, so system/developer items, complete tool-call/result units, opaque reasoning and signature blocks and the pending tail (calls awaiting results) survive; Anthropic histories still start with a user turn. Every candidate is validated against a per-shape Zod schema plus call/result pairing before anything is persisted; an invalid result throws and leaves the task unchanged. Automatic warnings (`task.context-warning`) fire once per turn when the conservative reservation reaches 80% of the profile context limit; the previous "compaction is not available yet" limit error now points at compaction. Compaction is refused while a response is active or a task is retired.
- **MCP under the same policy.** `mcp.save/list/remove` configure stdio servers by absolute `.exe` command, arguments, optional working directory and a restricted environment (credential-like and reserved names refused, secret-like values refused at configuration). Saving launches the server once through `mcp-host.ps1`, a kill-on-close Windows Job Object host that verifies the runtime parent, lets the server inherit the runtime's pipes directly, terminates the job on cancellation, lifetime expiry or parent death, and writes a nonce-bearing result once the job is verified empty. Tool listings are bounded (128 tools, 1 KB descriptions, 16 KB schemas, provider-safe names) and stored; coding tasks advertise them as `mcp__key__tool`. Only tools on the user-managed read-only allowlist run within policy; every other call creates a one-shot approval bound to the exact screened arguments (`Approval.mcp`). Server annotations are shown as hints only. Arguments and results are secret-screened; results are bounded to 64 KB with head/tail excerpts; a timeout or broken transport after the request was sent marks the approval **unknown**, stops the server, and is never replayed. Servers idle-stop after two minutes and are terminated with their descendants on runtime shutdown.
- **Usage visibility and diagnostics.** Every provider reservation is recorded in the additive `usage_records` table with prompt, completion, cache-read and cache-creation tokens (Anthropic cache fields and OpenAI `cached_tokens` are now surfaced by the adapters) or, when usage is unknown, the retained reservation and its reason. `task.usage` returns the burndown, the conservative next-request estimate against the context limit, totals and the compaction history; the Usage panel renders it. `diagnostics.export` writes a sanitized JSON bundle (profiles without credentials, task and usage summaries, approval metadata without before/after/patch/command text, MCP configuration without environment values, bounded recent events) through the redactor and refuses to write if secret-like content remains.
- **Explicit commit/push and safe retirement.** `task.commit`, `task.push` and `task.retire` exist only as user actions in the Publish panel; no tool proposes them. Commit stages every change except secret-named paths (index reset if one slips through), runs with hooks disabled and no signing, and uses the user's Git identity. Push targets a remote configured in the project repository, never forces or prompts, and is the only Git action that may use the user's credential helper. Retirement checks every worktree of the task (children included for coordinated roots) read-only first, refuses when any has uncommitted or untracked files, then removes them with `git worktree remove` without `--force`; the branch, commits, history and evidence remain and the task becomes `retired`. Each action records an intent first and marks it unknown on an ambiguous failure.
- **Worktree creation race.** Concurrent `git worktree add` calls in one repository raced on Git's worktree metadata (observed as a pre-existing flake in `coding.test.ts`); creation is now serialized per repository.

### Validation (owner-run)

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Types, lint, tests | `pnpm check`: **19 files, 192 tests passed (clean typecheck and lint)** | Prior suites plus compaction shapes/validation (unit), MCP JSON-RPC client bounds (unit), compaction integration with a real Chat-Completions-shaped continuation, MCP integration through the real Job Object host and fixture server (allowlist vs approval, rejection, redaction, truncation, timeout as unknown outcome, descendant termination on shutdown), commit/push/retire/diagnostics integration against a bare remote, creation-race regression, and all 6 post-review regression tests (tool outcome blocking, MCP EPIPE handling, store recovery reservation reset, commit exact identity verification, push ancestry verification, startTurn intent blocking). |
| Desktop user paths | `pnpm test:e2e`: **7 passed** | Prior Chat, Coding and coordinated paths plus a Phase 04 flow: chat compaction with the summary rendered, MCP server configured from settings with the read-only allowlist, `/mcp-demo` stopping at the write_note approval ([screenshot](mcp-approval-screenshot.png)), diagnostics export scrubbed of a credential canary, explicit commit, and retirement of a clean worktree. |
| Packaged runtime | `pnpm package:dir` and `pnpm smoke:package`: **passed** | Packaged Electron/SQLite runtime: prior coding and coordinated flows plus compaction, the MCP demo through the unpacked `mcp-host.ps1`, diagnostics export, and commit/retire. |
| Independent review | Completed; all initial Sonnet findings plus all 6 subsequent Codex/GitGuardian review findings addressed on commit `81dbd83` and re-verified. | Independent reviews covering security, persistence, Git publication, IPC and QA coverage closed with zero remaining findings. |

Logs are in `.local/validation/` of the implementation worktree (`phase04-check.log`, `phase04-e2e.log`, `phase04-package.log`, `phase04-smoke.log`).

### Independent review findings

Two bounded, read-only Sonnet reviewers (below the Fable owner; neither authored the code) reviewed the diff against `main` before the initial validation cycle. Subsequent automated Codex review and GitGuardian scanning on PR #2 identified 6 additional findings that were remediated on commit `81dbd83`.

Security, persistence and IPC review:

- **P1 fixed.** `task.commit` ran `git add --all` without re-checking Git filter attributes, so a `.gitattributes` edit made through an ordinary reviewed file change could have run a clean filter with the user's privileges during the explicit commit. Commit now re-checks every tracked path and every path about to be staged and refuses when a `filter` attribute is present (regression test in `publish.test.ts`).
- **P2 fixed.** The MCP host launched the server with `bInheritHandles` and no handle list, so any inheritable handle open in the PowerShell host could have reached the server. The host now uses `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` so exactly the three standard handles are inherited.
- **P2 fixed.** Environment-name screening for MCP servers was a short substring list; segment names such as `AUTH`, `KEY`, `PASS`, `PAT`, `PWD`, `SESSION` and `SIGNING` plus `bearer`/`private`/`passwd` are now refused, and the settings copy states that values are stored in plain text and that screening is best-effort.
- **P3 fixed.** The host's `cleanupVerified` result was discarded; an unverified stop is now surfaced as the server's status note (visible in settings and diagnostics).
- **P3 accepted.** The retire dirty-check and removal are two steps; Git's own refusal to remove a dirty worktree without `--force` covers the window, and a race fails loudly rather than deleting files.
- Verified sound: allowlist-only execution authority (annotations never used for policy), command/cwd/environment validation, parent verification and job termination paths in the host, JSON-RPC bounds and refusal of server-initiated requests, unknown-outcome classification, compaction validation and atomic persistence, diagnostics redaction and field selection, no-force push and app-owned-path checks for removal, and Zod validation of every new RPC in both main and runtime.

Codex and GitGuardian post-PR review findings (closed on commit `81dbd83`):
- **Finding 1 fixed (Git publication safety):** `publishable()` in `packages/runtime/src/workspace-operations.ts` explicitly rejects `task.commit` and `task.push` when any tool approval in the task is in an `unknown` state.
- **Finding 2 fixed (MCP transport error handling):** `McpClient` in `packages/runtime/src/mcp.ts` registers an output error listener on stdin, catches synchronous and asynchronous `Writable.write()` transport errors (e.g. `EPIPE`), and classifies in-flight calls as durable `unknown` outcomes rather than crashing Node.
- **Finding 3 fixed (Reservation atomicity & store recovery):** `legacyHooks.reserve` persists `status: 'running'` atomically with token holds; `store.recover()` resets unstarted holds on idle tasks with 0 messages to 0 tokens without wiping historical usage.
- **Finding 4 fixed (Commit identity verification):** `verifyCommitOutcome` in `packages/runtime/src/repository.ts` & `workspace-operations.ts` verifies exact commit identity (`HEAD^ == baseCommit` and commit message match) before declaring success; discarding staged changes without committing is identified as failed.
- **Finding 5 fixed (Push ancestry verification):** `verifyPushOutcome` in `packages/runtime/src/repository.ts` runs `git merge-base --is-ancestor` when remote tip differs, returning `undefined` (inconclusive / remains unknown) if ancestry cannot be proven.
- **Finding 6 fixed (Turn execution fencing):** `startTurn` in `packages/runtime/src/service.ts` blocks `task.send` while `unknownRetireIntents` or `unknownPublicationIntents` remain unreconciled.
- GitGuardian security scan passed with 0 secret leaks or vulnerabilities detected.

QA and coverage review (added as regression tests): compaction refused while a mutation outcome is unknown; retirement/commit/push refused on a coordinated root with non-terminal runs; a pending MCP approval is revoked when the runtime stops and the interrupted call is answered with an error rather than replayed; the unknown-usage accounting path (`unknownRequests`, `reservedUnknown`); a specific assertion for a server that fails to start; the push confirmation token asserted as a schema rejection. Accepted without tests: idle/lifetime timers (time-based), push over HTTPS without a helper (network), and coordinator/child compaction beyond the fixed system-item guarantee.

### Known limits of this increment

- Summaries are deterministic excerpts, not model-written prose; a summarized turn loses detail, which is why the originals stay in the transcript. Compaction is manual; the runtime only warns automatically.
- Coordinated roots and children can be compacted while idle, but their long-lived coordinator brief is a system item and therefore always retained; there is no separate compaction of orchestration records (assignments and results live in SQLite, not in context).
- MCP tool schemas are passed to providers as supplied by the server (bounded, redacted, not validated as JSON Schema); argument validation against the schema is left to the server. Only stdio servers are supported; HTTP/SSE transports, sampling, roots and elicitation are refused. MCP tools are advertised to single-agent coding tasks only.
- The MCP host inherits the same PowerShell/C#-compilation requirement as the command helper and adds roughly one second of startup per server launch.
- Push relies on the user's credential helper or SSH agent; there is no in-app credential prompt. Commit uses `git add --all`, so intentionally untracked scratch files must be ignored or removed first.
- `retired` is recorded in the task JSON; the additive Phase 04 tables are created with `IF NOT EXISTS` on open rather than through a numbered schema version, so an older build ignores them and a newer one reads them without migration.

---

## Local task-branch integration — 17 September 2026

Claude's completed `3a45143` branch was merged without conflicts into `agent/codex/foundation/foundry-agent-workspace` at `aa524c9bb62f26a709f5d791c9bab7fa0fdb9bcc`. Application source matches the independently reviewed final Claude branch; the extra change is the comprehensive HTML progress section. Subsequent documentation commits do not change application code.

Codex reran the required checks in this checkout: `pnpm check` passed (145 tests, clean typecheck/lint); `pnpm test:e2e` passed (6 tests); `pnpm package:dir` exited 0; `pnpm smoke:package` passed (14 bound approvals, at most two active children, three serial integrations and exact-tree validation). Full logs: `.local/validation/integrated-check.log`, `integrated-e2e.log`, `integrated-package.log`, `integrated-smoke.log`.

Packaged `resources/app.asar` SHA-256: `ba77f180c5a2c1f1cd0342c62f926cd95cde7a82f747988fa611820371752bb0`.

Rudy authorized push, PR and merge. Publication remains blocked because this repository has no configured remote/default branch; destination requested. This local task-branch merge is not a remote/default-branch merge. No PR URL, CI result, live Foundry qualification, signed installer or deployment is claimed. The historical evidence below retains its original source and scope.


## Coordinated orchestration increment

Recorded 17 September 2026 (America/Chicago) on private branch `agent/claude/coordinator-orchestration`, a direct descendant of `f75d1ed` (0.2.0). This implements the [approved coordinator plan](coordinator-orchestration-plan.md). It is a local engineering build, not full v1 acceptance. Validated code commit: `3e5385e316248802296764ec10b01d0dae442cd8`; a following documentation-only commit records this evidence.

### Delivered

- Explicit `coordinated` task mode. Chat, Coding and records without `mode` keep their previous behavior; child agents never appear as top-level tasks and `task.send`/`task.cancel` on a child are rejected before any provider or repository activity.
- SQLite schema v2: immutable assignments (at most eight revisions per task), depth-one agent runs with generation fencing, at most two admitted nonterminal children, dependencies, budget holds/reservations/settlements, deliver-once waits, handoff and integration operations, validation evidence and completion records. Database triggers enforce immutability, no resurrection, no reversal of fencing and retention. New databases start at v2. An existing v1 database opens unchanged; the desktop banner performs a separately confirmed upgrade that first creates a WAL-aware SQLite backup, verifies it (integrity, version, row counts), then migrates in one transaction. Rollback means opening the retained v1 backup with 0.2.0; v2 is never downgraded in place.
- Aggregate budget authority: charged, in-flight, unused child holds and unallocated funds reconcile to the cap; 20% of the cap is protected for the coordinator; holds convert to reservations without double counting; settlement is idempotent; interrupted or unknown usage is retained in full; overruns are recorded and block admission.
- Bounded scheduler: round-robin admission across tasks, the shared three-slot limit plus a two-request per-profile limit for coordinated runs, excess assignments unprovisioned with no worktree or hold, and dependent children admitted only after predecessors are integrated and the required combined validation passed on the current HEAD/tree. Dependencies resolve through assignment revisions.
- Native coordinator tools (`delegate_assignments`, `await_children`, `integrate_result`, `complete_task`) and child tools (`commit_handoff`, `submit_handoff`) with role policy enforced at the runtime boundary. The coordinator waits without an execution slot and receives one bounded, redacted result per child. Child prose is labelled as an untrusted claim.
- Scope policy: segment-aware, Windows case-insensitive read/write scopes; overlapping concurrent write scopes are rejected; `.git`, `.gitmodules`, `.gitattributes`, secret names, reserved names and traversal are denied; scope is enforced before file access and rechecked at commit and integration.
- Typed Git operations with a sanitized environment (every inherited `GIT_*` variable stripped): exact-base child worktrees (filter attributes read from the base tree), one reviewed handoff commit per assignment (literal staging, blob/mode verification, `write-tree`/`commit-tree`/compare-and-swap `update-ref`), canonical effect manifests, serial `cherry-pick --no-edit -x` integration verified by parent and exact effect, preserved conflicts continued only with a newly approved resolved index tree, distinct blocked empty outcomes, and read-only reconciliation of unknown worktree creation, handoffs and integrations. Nothing resets, aborts, skips, cleans or deletes worktrees.
- Bound approvals: every coordinated approval binds root, target agent, assignment revision, generation and fingerprint and is decided only through `orchestration.decide`; stale or sibling decisions fail. Validation evidence binds the exact command, working directory, timeout, HEAD, tree, clean state and verified cleanup; commands with model-supplied environment changes never count as validation. Completion requires every assignment integrated, no pending/unknown effect or conflict, a clean task worktree and passing combined validation on the exact current tree.
- Scoped cancellation (child or whole task, fenced durably first) and restart recovery that never resumes paid inference or mutations: reservations are retained, approvals revoked, in-flight Git operations marked unknown, and explicit Resume reconciles read-only, starts only never-started children and delivers a recorded wait once.
- Desktop: upgrade banner, coordinated task creation (child profiles, required validation command, budget), agent tree, aggregate budget and completion header, per-child read-only detail and assignment, bound approval cards with target labels and patches, orchestration tab (assignments with revision, results, integrations with check/continue, evidence, events), scoped cancel controls. The deterministic offline `/orchestrate-demo` fixture exercises two independent children and one dependent child.

### Validation (owner-run on `3e5385e`)

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Types, lint, tests | `pnpm check`: **14 files, 145 tests passed** | 83 prior tests plus schema/upgrade/budget/constraints (15), scope (4), execution slots (2), Git operations (27) and orchestration integration (14) using real temporary Git repositories, SQLite and Windows commands with injected providers. |
| Desktop user paths | `pnpm test:e2e`: **6 passed** | Prior Chat and Coding paths; full coordinated workflow through rendered approvals with real commits and restart; scoped child and root cancellation; IPC forgery rejection; v1 database with legacy history upgraded through the banner. |
| Packaged runtime | `pnpm package:dir` and `pnpm smoke:package`: **passed** | Packaged Electron/SQLite v2 runtime: prior coding demo plus coordinated workflow with 14 bound approvals, at most two active children, three serial cherry-picks, combined validation on the exact final tree, source repository unchanged. `resources/app.asar` SHA-256 `ba77f180c5a2c1f1cd0342c62f926cd95cde7a82f747988fa611820371752bb0`. |
| Independent review | Three read-only reviewers, none an author; fixes re-verified by the Git and QA reviewers | Security/IPC/credentials/persistence: one P2 (evidence environment binding) fixed. Git operations: two P1 (base-tree filter check, inherited `GIT_*`), one P2 (embedded repositories), one P3 fixed. QA/data integrity: one P0 (unknown worktree creation), one P1 (revisions orphaning dependents), one P2 (wait on unadmittable assignment), P3s fixed. Each fix has a regression test. |

Logs are in `.local/validation/` of the implementation worktree (`final-check.log`, `final-e2e.log`, `final-package.log`, `final-smoke.log`, plus earlier `check-orchestration-*.log`). No live Azure request, CI run, remote publication, installer build, signing or clean-profile installation is claimed for this increment.

### Known limits of this increment

- Actual model-family qualification of the coordinator/child tool loop against real Foundry deployments is open; only injected transports and the offline fixture were exercised.
- Git 2.40 or newer is required (`check-attr --source`); older Git fails closed with a generic Git error.
- An unknown worktree creation, handoff or integration that reconciliation cannot prove stays blocked for manual inspection; there is no automated adoption or cleanup.
- Worktree-creation crashes were exercised by injected failures, not by killing a real process mid-operation. Deletion-guard triggers are asserted only for child results.
- Commands still run with the user's Windows privileges; scopes are checked on Git-visible changes, not enforced on process behavior.
- The main-process frame/origin check is exercised only for main-frame IPC; a subframe sender is not separately tested.
- The coordinator composer remains visible on a completed task (the runtime rejects the send), and the child-profile fieldset legend overlaps its border. *Both fixed 25 October 2026 (UI polish, below): the composer is disabled with a reason and the legend sits inside its box.*

---

# Earlier increment — reviewed coding tools

Recorded 17 September 2026 (America/Chicago), version 0.2.0. This is a local engineering build, not full v1 acceptance. The [original plan](foundry-agent-workspace-plan.html) remains the product baseline. Foundation commit: `6bbaef8`.

## Delivered

- Electron/React desktop, typed private JSON-RPC, supervised runtime, SQLite WAL history, OS-backed credential vault, explicit Azure profiles, and task-owned Git worktrees.
- Separate Chat and Coding modes. Real coding requires successful text, usage, cancellation, tool-call, and continuation qualification. The built-in `/demo` fixture performs a read, proposes a README edit, then proposes a harmless command without network access.
- Native Responses, Chat Completions, and Anthropic tool loops. Complete validated calls execute only after provider completion. Opaque reasoning/signatures remain outside renderer history. Tool results and native continuation survive restart; interrupted calls are never replayed.
- Bounded directory listing, literal text search, file reads, tracked/untracked diff inspection, and existing-file replacement with exact SHA-256 preconditions. New-file creation through the file tool is deliberately disabled because a safe Windows directory-relative primitive is not implemented.
- One-shot edit/command approvals bound to task, nonce, and exact proposal. File review includes before/after content and hashes. Command review includes script, canonical directory, fixed shell, environment, timeout, and worktree fingerprint. Stale and replayed decisions fail closed.
- Durable intent before mutations. Restart revokes unexecuted approvals and marks executing actions unknown. File reconciliation compares hashes read-only. Unknown command effects remain blocked in that task and are never treated as successful or automatically retried.
- Windows command supervision: suspended creation, Job assignment before execution, kill-on-close, cancellation/timeout, parent-process death monitoring, bounded output, minimal environment, and explicit cleanup evidence. Background descendants are terminated before completion. Commands run with the user's Windows privileges; approval and worktrees are not a sandbox.
- Three shared model/command slots; approval waits consume no slot. Conservative per-request reservations include tool schemas and native context. Turns stop at context/budget limits or 50 tools, retaining their work and evidence.
- Approval/history UI, rejection/cancellation, retained evidence after restart, and a per-user Windows installer candidate. [Reviewed approval screenshot](coding-approval-screenshot.png).

## Validation

The final local candidate passed the combined checks below. No live Azure request, CI run, remote publication, production deployment, or clean-profile installation is claimed.

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Types, lint, tests | `pnpm check`: **83 tests passed** | TypeScript and ESLint pass. Isolated Git/SQLite fixtures, injected provider transports, and actual Windows process lifecycle tests. |
| Desktop user paths | `pnpm test:e2e`: **2 tests passed** | Chat/settings/history path plus Coding `/demo`: rejection leaves content unchanged; exact approved edit and command succeed; source stays clean; restart preserves evidence. |
| Process crash | Command-runner integration host | Kills the owned Node runtime host and verifies both root and child command PIDs terminate. |
| Packaged runtime | `pnpm package:dir` and `pnpm smoke:package`: **passed** | Actual packaged Electron/SQLite, approved edit, unpacked Job helper, verified command cleanup, and unchanged source fixture. Smoke ran against the final package produced by the installer build. |
| Installer candidate | `pnpm package:win`: **passed** | `release/Foundry Agent Workspace Setup 0.2.0.exe`. Authenticode reports **NotSigned**. Build success is separate from clean installation and signing. |
| Dependencies | `pnpm audit`: **zero reported vulnerabilities** | Current registry result; no new production dependency was added for this increment. |
| Independent review | Three bounded specialists and owner integration | Provider fidelity, approval/persistence/recovery, filesystem protection, and Windows lifecycle findings addressed; full v1 review remains open. |

Validation logs are retained in `.local/validation/` (ignored by Git). `check-coding.log`, `e2e-coding.log`, `package-coding.log`, `packaged-smoke-coding.log`, and `audit-coding.json` identify this increment.

Final SHA-256 fingerprints:

- Installer: `9b26166d7583942b03050d1a72fa262fb5ba8f4427fb607d18fa4893c9ec4a5b`.
- Packaged `resources/app.asar`: `d0f6262ef4875aacde8af4d4584676ea38fae45f71f08047dcf533184b8dd534`.

## Important review findings closed

- Prevented new-file creation through an unsafe Windows parent-directory race; existing edits reject stale hashes, symlinks, hard links, and protected paths.
- Withheld untracked diff content when a tracked sensitive deletion could disguise a secret rename.
- Rejected forged/replayed/stale approvals, revoked waiting decisions on cancellation/restart, and distinguished known preflight failures from unknown mutation outcomes.
- Screened full provider state before persistence and kept native reasoning/signatures away from the renderer. Rejected repeated historical tool-call IDs.
- Made command preparations one-shot; refreshed worktree/shell/spec fingerprints before launch; discarded unused preparations.
- Fixed runtime-parent death, suspended-process assignment failure, helper environment, cancellation timing, background pipe holders, and unpacked helper resolution.
- Disabled OpenAI strict-schema mode for dynamic runtime tool schemas while retaining independent Zod validation.
- Rejected malformed terminal ordering, missing stop reasons, unfinished Anthropic blocks, negative/fractional usage, and mismatched authoritative Responses output.
- Capability probes now verify a random value supplied only through a fixture tool result. A failed fresh probe invalidates prior verification.

## Plan progress and remaining gates

| Plan stage | Actual position |
| --- | --- |
| 00 — Foundation verification | Local toolchain, native SQLite, package and installer path established. Actual Foundry deployment/authentication qualification remains open. |
| 01 — Desktop, state, isolation | Core local paths implemented and exercised. Large-history ergonomics and worktree-creation reconciliation remain. |
| 02 — Single-agent coding | Reviewed edits/commands, native tools, provider continuation, durable decisions, cancellation and conservative recovery implemented. Live model-family qualification remains open. |
| 03 — Coordinator/specialists | Implemented, independently reviewed, and merged to `main` at `70d0a0c`. Live model qualification remains open. |
| 04 — Context/external tools | **Delivered & validated on main (`db08e16`).** Implemented on branch `agent/claude/phase-04-context-and-tools` (commit `81dbd83`, PR #2): controlled compaction, MCP under approval policy, usage/diagnostics, explicit commit/push and safe retirement. 192 unit/integration tests, 7/7 E2E tests, package build and packaged smoke pass. Merged to `main` at `db08e16`. |
| 05 — Windows release | **Delivered & validated on main.** Parallel multi-agent delivery across 4 workstreams (Claude Opus 5 for security/IPC audit, Claude Sonnet for qualification framework & clean installer, Antigravity for recovery & evidence). Product-wide security audit suite (`tests/integration/security-audit.test.ts`), 5-point deployment qualification framework CLI (`scripts/qualify-deployments.mjs`), NSIS production installer build (`Foundry Agent Workspace Setup 0.2.0.exe`, 115.63 MB), clean installer audit script (`scripts/verify-clean-install.ps1`), recovery runbook (`docs/recovery.md`), Authenticode guide (`docs/signing-and-distribution.md`), and release evidence matrix (`docs/release-evidence.md`). 21 test files, 228 automated tests pass, 7/7 E2E tests pass, packaged smoke passes. |

All primary implementation phases (Phases 00 through 05) are delivered, merged, and validated on `main`.

Open qualification: live user-selected Azure Foundry deployment qualification via `scripts/qualify-deployments.mjs` with production credentials, production Authenticode certificate signing for Windows SmartScreen reputation, and distribution/license notice review. Routine automated test suites run 100% offline without discovering credentials or making paid probes.

## Practical limits

- Buffered response text appears after whole-response screening. A hard crash can lose the current in-memory fragment; prior messages and conservative reservations survive. Local cancellation does not prove server-side cancellation or billing cessation.
- Unknown worktree creation blocks further task creation. Preserve the recorded branch/path/registration and inspect the SQLite intent; automated adoption is not implemented.
- Unknown command effects require inspection. Read-only reconciliation cannot infer external effects or manufacture a missing exit/cleanup result. Create a separate task only after retaining and investigating the affected worktree.
- History pagination/export, compaction, remembered approvals, automatic runtime restart, provider fallback, updating, browser tools, scheduling and cloud hosting are absent. RPC/history limits fail visibly without deleting retained history.
- The runtime uses Git HEAD when creating worktrees; source uncommitted changes are preserved in the source checkout and are not copied. No implicit fetch, commit, push, PR, merge or worktree deletion occurs.
- Secret screening and same-user filesystem checks are defense in depth. Commands can act outside the worktree with the approved user's rights. Windows Job cleanup is not a security sandbox or proof that every external side effect was undone.
- This earlier increment used schema version 1. The orchestration increment introduces v2 with an explicit, backed-up upgrade.
- Command freshness checks currently fingerprint at most 10,000 files / 64 MiB of worktree content and reject larger trees, including large dependency folders. Commands start with a Windows-only PATH; use an explicit developer-tool path or set PATH in the reviewed script. Broader developer-tool discovery and scalable fingerprints remain usability work.

## Ownership and routing

All work remains on private local branch `agent/codex/foundation/foundry-agent-workspace`; no remote is configured. The owner integrated and validated the product. Three bounded agents were selected using Rudy's `AGENTS.md` and workflow-router guidance, each **GPT-5.6 Terra / medium**, below the parent route:

| Agent | Bounded implementation | Independent review |
| --- | --- | --- |
| `providers` | Native provider adapters, probes and transport tests | Runtime continuation and command runner |
| `desktop_ui` | Renderer approvals, coding E2E and screenshot | Repository/filesystem, approvals and provider/command boundaries |
| `repository_tools` | Windows Job helper, command runner and crash fixtures | Runtime persistence, budgets, approval ordering and recovery |

Agentcoord bridge health succeeded, but session registration remained unavailable; no durable claims were acquired. Explicit built-in agent messages separated file ownership on this owned local branch. No external messages or publication occurred.

Primary implementation references: [Foundry Responses](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses), [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [Anthropic extended thinking](https://platform.claude.com/docs/en/about-claude/models/extended-thinking-models), and [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects). Documentation is not evidence of compatibility with a specific deployment.
