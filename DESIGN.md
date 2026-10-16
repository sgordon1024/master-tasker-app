---
name: Master Tasker
description: A calm task board on your own Mac, where one thing is in focus and red means you.
colors:
  # Light values. tokens.css is the source; it also holds the dark value of each role.
  primary: "#2F5BEA"
  primary-dark: "#7B97F8"
  surface-page: "oklch(0.995 0.006 255)"
  surface-pane: "oklch(0.96 0.006 255)"
  surface-card: "oklch(0.995 0.006 255)"
  surface-sunk: "oklch(0.968 0.006 255)"
  ink: "oklch(0.145 0.006 255)"
  ink-secondary: "oklch(0.52 0.006 255)"
  icon-quiet: "oklch(0.62 0.006 255)"
  chip-ink: "#505255"
  border-input: "oklch(0.62 0.006 255)"
  you: "oklch(0.55 0.2 17)"
  you-ink: "#FFFFFF"
  warning-ink: "#573800"
  success: "oklch(0.49 0.14 152)"
  surface-page-dark: "oklch(0.145 0.006 255)"
  surface-pane-dark: "oklch(0.185 0.006 255)"
  surface-card-dark: "oklch(0.235 0.006 255)"
  ink-dark: "oklch(0.985 0.006 255)"
  ink-secondary-dark: "oklch(0.74 0.006 255)"
  border-input-dark: "oklch(0.55 0.006 255)"
  you-dark: "oklch(0.72 0.16 15)"
  area-indigo: "oklch(0.55 0.14 270)"
  area-violet: "oklch(0.55 0.14 310)"
  area-orange: "oklch(0.55 0.136 55)"
  area-teal: "oklch(0.55 0.096 185)"
  area-olive: "oklch(0.55 0.112 95)"
  area-rose: "oklch(0.55 0.14 350)"
  area-green: "oklch(0.55 0.14 140)"
  area-blue: "oklch(0.55 0.108 230)"
typography:
  focus:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "40px"
    fontWeight: 600
    lineHeight: "46px"
    letterSpacing: "-0.02em"
  view:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: "32px"
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "26px"
    letterSpacing: "-0.011em"
  capture:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "24px"
  body:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
    fontFeature: "'cv11'"
  meta:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  label:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  badge:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "1"
    fontFeature: "'tnum'"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
rounded:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  full: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "12": "48px"
  "16": "64px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "36px"
  button-focus:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    typography: "{typography.capture}"
    rounded: "{rounded.full}"
    padding: "12px 24px"
    height: "48px"
  input:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  capture:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.capture}"
    rounded: "{rounded.md}"
    height: "48px"
  chip:
    textColor: "{colors.chip-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "22px"
  task-card:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "12px"
  needs-you-label:
    backgroundColor: "{colors.you}"
    textColor: "{colors.you-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "1px 8px 1px 6px"
  badge-you:
    backgroundColor: "{colors.you}"
    textColor: "{colors.you-ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.full}"
    height: "18px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "4px 12px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  board-column:
    backgroundColor: "{colors.surface-pane}"
    rounded: "{rounded.lg}"
    width: "clamp(240px, 18vw, 288px)"
---

# Design System: Master Tasker

## Overview

**Creative North Star: "The Quiet Desk"**

Master Tasker is a desk you sit at all day, not a poster. It should feel like Focus mode everywhere: one clear thing to do, plenty of room, and nothing asking for attention unless it really needs you. Focus mode is the reference for the whole app. A plain page, one confident heading, one big button, and a small line of what comes next.

The system is built from one typeface, a short scale of sizes, three weights, and color that always means something. The surfaces step down gently from the page to the sidebar and board columns, and cards sit on top with a hairline border and a soft shadow, so light mode has real depth without boxes inside boxes. Dark mode is the same layout lit from below: cards are the lightest surface, the page is the darkest.

Color is spent on meaning. Blue (the accent, which a color theme can change) means "this is yours to act on" and "in progress". Red means only Needs you and Overdue. Area colors are small dots, never fills. Everything else is ink on paper.

**Key Characteristics:**
- One face (Inter), eight sizes, three weights.
- One centered 960px column for list views, so the header stays put between them; the board starts next to the sidebar and uses the full width.
- Light depth from tone and one soft shadow, not borders on borders.
- Red is reserved. Blue is for action and In progress. Area color is a dot.
- One shimmer in the whole app, on the task in progress. Everything else arrives and stays still.

## Colors

A cool, nearly colorless paper with one blue voice and one red warning.

### Primary
- **Baseline Blue** (`primary`, dark `primary-dark`): primary buttons, the selected nav icon, the In progress wash and its thin outline, focus rings in Focus mode and on fields, text selection at 26%. Color themes (Lagoon, Forest, Honey, Lavender, Graphite) swap this one color and tint the neutrals to match. Nothing else changes with the theme.

### Secondary
- **Needs You Red** (`you`, dark `you-dark`): the Needs you label and badge, the 1px outline on a task that needs you, the Overdue chip, and the summary links that lead to them. Text-safe on every surface, and a fill behind `you-ink` (white in light, near black in dark).

### Tertiary
- **Area hues** (`area-indigo` through `area-blue`): eight hues at the same lightness, spaced around the wheel and skipping red. An area stores its light value as hex; the app paints it with a CSS variable so it gets a lighter value (L 0.72) in dark mode. Areas show their color as a dot in the sidebar, on chips and in the title, never as a background.
- **Status** (`warning-ink`, `success`): Waiting text and the done check. Status text darkens a step in light mode, because Baseline's status colors are tuned for fills.

### Neutral
- **Paper** (`surface-page`): the page and every card in light mode.
- **Desk** (`surface-pane`): the sidebar and board columns, one step down (1.108:1 against the page).
- **Well** (`surface-sunk`): insets such as the segmented control, token boxes, empty-state icons and the week chart.
- **Ink** (`ink`): titles and body text.
- **Pencil** (`ink-secondary`): meta lines, labels, quiet buttons. Holds 4.5:1 on every surface.
- **Chip ink** (`chip-ink`): text on a chip's faint wash, a step darker than Pencil so it holds 4.5:1 there too.
- **Icon gray** (`icon-quiet`): icons only (3:1). Never for text people read.
- **Field line** (`border-input`): every text field, select and checkbox outline, at 3:1 or more on the page and the pane.

### Named Rules
**The Two Meanings Rule.** Red means Needs you or Overdue. Nothing else is red: not delete, not errors in passing, not a decoration. Destructive buttons are neutral until the one confirm button.

**The Dot Rule.** An area's color appears as a dot, never as a fill, a border or text color.

**The One Accent Rule.** A screen has one primary button at most. The accent's other jobs (In progress, focus, selection) are small.

## Typography

**Display Font:** Inter Variable (with ui-sans-serif, system-ui)
**Body Font:** Inter Variable, the same face
**Label/Mono Font:** ui-monospace, for IDs, paths and code only

**Character:** One confident, neutral grotesque at every size. Optical sizing tightens the big Focus heading and opens the small labels. `cv11` gives a single-story a. Inter ships with the app under the SIL Open Font License 1.1, so it looks the same on every Mac.

### Hierarchy
- **Focus** (600, 40px, 46px): the one step in Focus mode. Nothing else is this big.
- **View** (600, 28px, 32px, -0.02em): the page title, such as Today or an area name.
- **Title** (600, 20px, 26px, -0.011em): a task's title in its panel, dialog titles, Settings section heads.
- **Capture** (400, 16px, 24px): the Add field, the first-run card title, the Focus button.
- **Body** (400, 14px, 20px): task titles in lists, everything you read. Medium (500) for the task in progress and active nav.
- **Meta** (400, 13px, 18px): the summary line under a title, descriptions, help text.
- **Label** (500, 12px, 16px, sentence case): field labels, group heads, chips, the Needs you pill.
- **Badge** (500, 11px, tabular numerals): numbers inside pill badges, and nothing else.

### Named Rules
**The Twelve Rule.** No text people read is smaller than 12px. Only badge numerals are 11px.

**The Sentence Case Rule.** Labels and group heads are sentence case at 12/500. No uppercase eyebrows, no letter-spaced caps.

**The Number Rule.** Counts use tabular numerals in the body face. Mono is only for things that are code.

## Layout

The app is a three-part shell: a 264px sidebar, the main column, and a 440px task panel that opens on the right. The main column centers its title, toolbar and content on one shared gutter, `max(32px, (100% - measure) / 2)`, so they always line up. List views share one 960px measure, so the title, summary and toolbar stay put when you switch between them (the summary row keeps its height even when empty). The Wizard uses 1160px. The board starts 32px from the sidebar and uses the whole width with 240 to 288px columns, however wide the window, so it never floats in the middle of a wide screen. Capture sits on its own full-width row under the toolbar, with a one-line syntax hint on focus and the parsed result shown below the field, never beside it.

Spacing comes from a 4px base: 4, 8, 12, 16, 20, 24, 32, 48, 64. Groups sit 32px apart, each under a 12px label with a hairline rule. The topbar has 24px above the title and 16px below.

Controls come in four heights: 28px inside a row, 32px small, 36px default, 44px for touch and the one big Focus button (48px). On a coarse pointer, buttons, icon buttons, nav rows and menu items grow to 44px.

Below 1180px the task panel becomes an overlay sheet. Below 760px the gutter drops to 16px and a bottom tab bar (Today, Inbox, For you, In progress, More) takes over; More opens the sidebar as a drawer, and there is no separate menu button. Labels in the tab bar stay on one line. The summary is one line, search sits behind an icon, only capture stays pinned while the page scrolls, and help copy says tap, not press.

## Elevation & Depth

Depth is tone first, shadow second. In light mode the sidebar and board columns sit one tonal step below the page, and cards come back up to paper white with a hairline border (12% ink) and a two-layer shadow that is barely there. In dark mode the order flips: cards are the lightest surface, so they need almost no shadow. Dialogs and the narrow-window panel lift on a long, soft shadow rather than a dark halo.

### Shadow Vocabulary
- **Card rest** (`box-shadow: 0 1px 2px rgb(10 10 10 / 0.06), 0 1px 1px rgb(10 10 10 / 0.03)`): every card, the capture field, the active nav item.
- **Card hover** (`box-shadow: 0 4px 12px -4px rgb(10 10 10 / 0.12), 0 1px 2px rgb(10 10 10 / 0.05)`): a card you point at.
- **Lift** (`box-shadow: 0 24px 48px -20px rgb(10 10 10 / 0.22), 0 4px 12px -6px rgb(10 10 10 / 0.08)`): dialogs, menus, the panel as a sheet.
- **Drawn rest** (`filter: drop-shadow(0 1px 1.5px rgb(10 10 10 / 0.07))`, `--shadow-drop`): Card rest for a shape in the tour's pictures, where a box-shadow can't go.

### Named Rules
**The One Step Rule.** Each surface is one step from its neighbor, at least 1.08:1. Never a box inside a box inside a box.

## Shapes

Gently rounded and consistent. Controls and nav items use 8px. Cards, the capture field and toasts use 12px. Board columns, dialogs and the first-run card use 20px. Chips, badges, the Needs you pill, the Focus button and color swatches are full pills or circles. The task in progress is marked by a 1px accent outline all the way round, at 45% strength, over its wash. Never mark a card, row or callout with a colored stripe on one side.

The brand mark is a rounded square tile in the accent: a ring (the task in focus), a short bar beside it, and a longer, fainter bar below (what comes later).

## Components

### Buttons
- **Shape:** gently rounded (8px), 36px tall, 16px side padding, 500 weight.
- **Primary:** the accent with white text. One per screen at most.
- **Secondary:** paper with the card border and rest shadow. Hover darkens the border.
- **Ghost:** no fill, Pencil text, a faint fill on hover.
- **Danger:** neutral text everywhere, except the one confirm button, which is red.
- **Focus:** a 48px accent pill at Capture size, with the Return key shown inside it. Its focus ring is the accent, 2px, 3px out.

### Chips
- **Style:** 22px pills with a 5% ink wash and Chip ink text at Label size. Low priority is plain Pencil text with no chip. Sample is an outline.
- **State:** Overdue uses Needs You Red text on its own faint wash. Today uses the accent wash.

### Cards / Containers
- **Corner Style:** 12px.
- **Background:** paper in light, the raised surface in dark.
- **Shadow Strategy:** Card rest, Card hover on pointer (see Elevation & Depth).
- **Border:** 1px at 12% ink in light, 9% white in dark.
- **Internal Padding:** 12px.

### Inputs / Fields
- **Style:** paper fill, a 1px Field line outline, 8px corners, 36px tall.
- **Focus:** a 2px accent outline replaces the border.
- **Quiet fields:** a task's title and subtask names read as plain text until you point at them, then show the Field line.

### Navigation
- **Style:** 36px rows at Body size in Pencil, with 16px icons. The active row becomes a paper card with the rest shadow, ink text at 500, and an accent icon. Counts are plain tabular numerals; only Needs you gets a red pill.
- **Mobile:** a bottom tab bar with 12px labels, badges on the icons. More is the only way into the drawer.
- **Board views:** Next, Waiting and Done sit under Board in the sidebar.

### Task in progress (signature)
A 7% accent wash (10% in dark) over the card, a 1px accent outline all the way round (45% strength), and the app's one shimmer: a soft highlight that sweeps across every 3.2 seconds. The In progress nav item shows a still rainbow dot. Reduced motion turns the shimmer off.

### Needs you (signature)
A paper card with a 1px outline at 45% Needs You Red, and a red pill label with a hand icon above the task. The red is the only loud thing on the screen, by design.

### Onboarding tour
The first time a browser opens the app, once the tasks load, a full-window tour explains it in three steps: capture then sort, one thing at a time, and your AI assistant (optional, and you stay in charge). It is a modal dialog named "How Master Tasker works", on the page surface like Focus: a picture, "1 of 3" under three dots, the step title at View size, one or two plain sentences at Capture size, then Back and one filled button (Next, and "Start using Master Tasker" on the last step). Skip tour, with Esc, sits top right. The arrow keys step, Tab stays inside, and focus goes back where it was. Finishing or skipping saves `mt.tour` in this browser. A browser that already has Master Tasker prefs never gets it unasked. Take the tour sits under More in the sidebar, on the Getting started card and in the ⌘K palette. Below 600px, Back and the button share one row and the button takes the rest of it.

**Tour pictures.** One diagram per step, inline SVG drawn from the app's own parts: cards, area chips, columns, the check, a Focus step, the progress ring and week bars, the Needs you pill, For you with its badge.
- Drawn at 1:1, so 12px in the picture is 12px on screen. Two layouts: 616px wide, and 320px wide below 720px. Only under 352px does the narrow one scale down a little.
- Colors only from tokens, through classes in `tour.css`, so light, dark and every color theme follow. Red only for Needs you, area colors only as dots. A drawn button is an accent wash, so the tour's own button stays the one filled button.
- Arrows are 1.5px Icon quiet lines with a small open head, and a short 12/500 label only where the flow needs one.
- The assistant is a plain four-point spark in the accent. No app's mark or name appears in a picture.
- Each part arrives once, in order, eased out, all within about 1.5 seconds: lines draw, one card glides to its column, checks pop. Nothing loops. With reduced motion every picture appears finished.

## Do's and Don'ts

### Do:
- **Do** take every value from a token in `web/src/styles/tokens.css` or Baseline. Components never hold raw colors or sizes.
- **Do** keep text at 12px or larger, and every text pair at 4.5:1 (3:1 for icons and field outlines), in light and dark.
- **Do** use sentence case at 12/500 for labels and group heads.
- **Do** let arrivals ease out (`cubic-bezier(.16, 1, .3, 1)`) in 100 to 200ms. Only the completion check springs.
- **Do** check light and dark, at 1440x900 and on a phone, after any visual change, and run `npm run screenshots`.

### Don't:
- **Don't** put a colored stripe or thick border on one side of a card, row, callout or panel (no `border-left`, no `inset 3px 0 0`). Mark state with a wash, a full thin outline, or a chip.
- **Don't** use red for anything but Needs you and Overdue.
- **Don't** fill a surface with an area color. Use the dot.
- **Don't** add a second shimmer, pulse or looping animation. The task in progress has the only one.
- **Don't** use uppercase, letter-spaced eyebrows, or a mono face for numbers that aren't code.
- **Don't** add font sizes or weights outside the scale above.
- **Don't** edit `web/src/styles/baseline/`. Override in `tokens.css`.
- **Don't** carry the Wizard lab's look elsewhere. It keeps its own pixel-art colors and mono uppercase panel labels for charm, and takes its type sizes, field lines and Needs You Red from the tokens like everything else.
