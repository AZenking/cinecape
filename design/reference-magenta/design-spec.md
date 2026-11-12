# MagentaTV EPG (https://www.magenta.tv/tv-guide) — Design Specification

Date of capture: 2026-11-11 (a Wednesday), ~20:45–21:10 local (Europe/Berlin evening, EPG showing 18:30–23:00 prime time).
Captured with ego-browser (Chromium, desktop window 1696×975, emulated layouts at 1440×900 / 768×1024 / 390×844, dpr 1).
Cookie consent (OneTrust) accepted before all screenshots. All measurements are CSS px. Values marked *(measured)* come from
DOM computed styles / pixel sampling; values marked *(est.)* are estimated from screenshots.

Implementation notes for rebuild: the page is a **React SPA** ("MagentaTV – Programmübersicht"), all grid logic is custom
(virtualized, transform-based timeline), styling uses **CSS Modules with hashed class names** (e.g. `fNeCq`, `Onr55` — these
are **unstable**, do not copy them). Stable anchors are the **element IDs and ARIA attributes** listed in §5.

---

## 1. Page layout anatomy (desktop, top → bottom)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 1. Telekom brand banner   #E20074, h=73px (in-flow, scrolls away)            │
│    left: Telekom "T" square logo + "Connecting your world." (white)          │
├──────────────────────────────────────────────────────────────────────────────┤
│ 2. Abo strip              dark magenta ≈#922251, h≈52px (in-flow)            │
│    right-aligned underlined white link: "Jetzt Abo abschließen"              │
├──────────────────────────────────────────────────────────────────────────────┤
│ 3. EPG nav bar            near-black #0F0F0F (measured rgb 15,15,15),        │
│    h≈100px, STICKY (pins to viewport top when grid is scrolled)              │
│    left:  "MAGENTA TV" wordmark in magenta #E20074 (link, aria               │
│           "MagentaTV Startseite", x=76, w=128)                               │
│    right: [Datum combobox] [filter icon] [grid icon] [search icon]           │
│           [avatar icon] [Login]  (a further "Info" icon button exists in     │
│           the row at ≥1696px width / after programme selection)              │
├──────────────────────────────────────────────────────────────────────────────┤
│ 4. Timeline axis row      h≈45px, STICKY directly under nav bar              │
│    [‹ chevron 24×24]  time labels 18:30  19:00  19:30 … every 180px          │
│    … [Jetzt pill] …                                  [chevron › 24×24]       │
├────┬─────────────────────────────────────────────────────────────────────────┤
│ 5. │ EPG GRID — vertical virtualized list of all 374 channels                │
│Ch. │ 84px-tall channel rows; horizontal 24h-timeline per row                 │
│col │ 6px per minute → 180px per 30 min → 8,640px per day                     │
│84px│ magenta 2px vertical "now" line crosses the full grid height            │
│    │ (21 days are pannable horizontally: 4. Nov … 24. Nov)                   │
├────┴─────────────────────────────────────────────────────────────────────────┤
│ 6. Site footer  (in-flow after last channel row)                             │
│    4 link columns: PRODUKTE / SERVICE / THEMEN / SOCIAL MEDIA                │
│    Telekom logo, "© Telekom Deutschland GmbH",                               │
│    legal row: Impressum · AGB · Cookie Einstellungen · Hilfe & FAQ ·         │
│    Kontakt · Datenschutz · Über MagentaTV                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

Footer link contents *(measured)*:
- **PRODUKTE**: MagentaTV Tarife, Zubuchoptionen, MagentaTV One, Streaming-Dienste & Partner
- **SERVICE**: Über MagentaTV, Jugendschutz, Nutzung EU-Ausland, Unterstützte Geräte, Verbraucherinfos Videoload/Erotic Lounge
- **THEMEN**: Senderübersicht, MagentaTV+
- **SOCIAL MEDIA**: Facebook, Twitter, YouTube, Instagram, Teilnahmebedingungen

### 5. Grid geometry (measured at 1440px)

| Token | Value |
|---|---|
| Channel column width | **84px**, sticky left, bg `#000000` |
| Channel row height | **84px** (programme lane), rows separated by 1px `#000` border/gap |
| Channel cell content | number (16px white, top-left), logo image (`<img>`, rendered ≈42×17; loaded from image service `https://ngiss.t-online.de/iss?client=ftp22&out=webp&x=240&y=96&ar=keep&src=<logo-url>`), gold "add channel" icon 12×12 at offset (64,10) top-right (`…/static-app/icons/add-channel.svg`) — indicates "add this channel to my list" |
| Timeline scale | **6px/min** (desktop): 30min = 180px, 1h = 360px, day = 8,640px; whole timeline is panned with `transform: translateX` (virtualized; content exists left of the current window, e.g. label "00:00" at x ≈ −67,000 for later days) |
| Programme block | width = duration × 6px (e.g. 90min → 540px; measured: 28min→166px, 50min→298px, 3h→1078px); very short entries collapse to ≈40px with text truncated to initials |
| Block vertical fill | full 84px row height minus 1px separator |
| Running-now blocks | bg **#1A1A1A** (rgb 26,26,26) — the lighter blocks visible around the now-line |
| Past + future blocks | bg **#0D0D0D** (rgb 13,13,13) |
| Block text | title span 20px/400 white, **opacity 0.4**; meta span "HH:MM - HH:MM \| Genre" 16px/400 white, opacity 0.4; left padding 16px; both spans `aria-hidden` (button carries full aria-label) |
| Block wrapper | `<button>` `aria-haspopup="dialog"`, `id="epg_pr_<programmeId>_<row>_<index>"`, `aria-label="{Channel}, {Titel}, {Start} bis {Ende}, {Genre}"` e.g. "ZDF, Die Küchenschlacht, 21:15 bis 22:00, Kochen"; `cursor: pointer`; border-left 1px solid black on the outer lane div |
| Midnight-spanning block | time range truncated with ellipsis ("21:00 - …"), shows continuation into next day |
| Off-air channel | placeholder lane: dimmed "Sendepause" + single time ("13:00"), no genre |
| Channels without metadata | plain half-hour slots "Willkommen bei …" 06:00–06:30 etc. (INFO channel 998) |
| "Now" indicator | 2px-wide magenta `#E20074` vertical line, `position:absolute`, spans entire grid height; on the axis a pill-button "Jetzt" (52×24, bg #E20074, white bold 16px, radius 4px, `aria-label="zur aktuellen Zeit"`) |
| Channel numbering | follows MagentaTV LCN with gaps: 1 Das Erste, 2 ZDF, 3 RTL, 4 (Sat.1), 5 (ProSieben), 6 VOX, 7 (RTLZWEI), 8 SUPER RTL … 827–831 (sky sport / BT TV), 998 INFO; list order = number ascending (sort "Nummer (1-9)") |

Channel count: **374 channels total**, rendered as ONE virtualized vertical list — there is **no "Weitere Sender laden"
button** (page scrollHeight ≈ 32,000px; rows outside the viewport are not in the DOM).

## 2. Visual design language

### Colors *(measured unless noted)*

| Token | Value | Usage |
|---|---|---|
| Telekom Magenta | **#E20074** (rgb 226,0,116) | brand banner, MAGENTA TV wordmark, "Jetzt" pill, now-line, links/accents |
| Dark magenta strip | **≈#922251** (rgb 146,34,81, pixel-sampled) | "Jetzt Abo abschließen" strip |
| Page background | **#040404** (rgb 4,4,4) | body |
| Nav bar | **#0F0F0F** (rgb 15,15,15) | sticky nav |
| Channel gutter | **#000000** | left column |
| Block (running now) | **#1A1A1A** | currently-airing programme blocks |
| Block (other) | **#0D0D0D** | past/future programme blocks |
| Block hover | **#262626** (rgb 38,38,38) | hovered block |
| Drawer / dropdown menu bg | **#191919** (rgb 25,25,25) | filter drawer, date dropdown |
| Dropdown selected row | ≈#3A3A3A–#4A4A4A *(est. from screenshot)* | current day / active option |
| Primary text | **#FFFFFF** | all labels |
| Programme text | white at **opacity 0.4** (effective ≈#676767 on #1A1A1A) | title + meta in blocks |
| Secondary text | **#A5A5A5** (rgb 165,165,165) | time axis labels |
| Separators | 1px **#000000** | between blocks/rows |
| Control borders | 1px ≈#4A4A4A *(est.)* | date combobox, drawer selects, search input |

The accent is confirmed **#E20074** (classic Telekom magenta) — used flat, no gradients anywhere.

### Typography

| Context | Spec |
|---|---|
| Font family | **TeleNeoWeb** (Telekom TeleNeo webfont; loaded faces include TeleNeoWeb-Regular; fallback sans-serif). *This brand font is not freely available — pick a metric-similar grotesque for the rebuild (e.g. Inter) and keep weights 400 only.* |
| Base / body | 16px / 400 |
| Programme title | 20px / 400 (not bold!), single line, ellipsis |
| Programme meta (time \| genre) | 16px / 400 |
| Time axis labels | 20px / 400, #A5A5A5 |
| "Jetzt" pill | 16px / 700 |
| Date combobox label | 16px / 400 |
| Drawer H2 "Filtern und Sortieren" | 32px / 400 |
| Channel number | 16px / 400 |
| Footer headings | 16px uppercase (letter-spacing), links 16px |

Note the distinct Telekom look: **almost everything is weight 400**, hierarchy is built purely from size + opacity.

### Shape, borders, spacing

- Radii: **0px** on blocks, rows, drawer; **3px** on date combobox (measured `border-radius: 3px`); **4px** on the "Jetzt" pill. Overall look is sharp/square.
- Shadows: no visible box-shadows on blocks; the date dropdown and drawer get a subtle dark drop shadow *(est.)*.
- Borders: 1px black gaps between all grid cells (grid gap effect); 1px gray borders on form controls.
- Spacing rhythm: 16px horizontal padding inside blocks; drawer padding ≈32px; footer column gutter ≈387px between columns (4 columns across 1544px content width); nav horizontal padding ≈76px left / ≈72px right.
- No drop shadows or elevation on programme blocks; hierarchy via background lightness only.

## 3. Interaction inventory

### 3.1 Date navigation
- **Control**: combobox button in the nav bar (right side), label shows current selection, e.g. "Heute 11. Nov.", chevron down; `role="combobox"`, `aria-haspopup="listbox"`, `aria-expanded`, `aria-activedescendant`; id `EPG-HEADER-DAYS-DROPDOWN-TOGGLE`.
- **Menu**: dark panel `#191919`, ≈182px wide, max-height ≈424px (9–10 visible rows, scrollable), each row ≈46px, 16px white text; the active day row is highlighted with a lighter gray band. Options (21): `Mittwoch 4. Nov.`, `Donnerstag 5. Nov.`, … relative names for adjacent days: `Gestern 10. Nov.`, `Heute 11. Nov.`, `Morgen 12. Nov.`, … up to `Dienstag 24. Nov.` (= today −6 … today +13).
- **Behavior**: selecting an option re-renders the whole grid for that day; the horizontal time-of-day scroll position is kept; option ids `EPG-HEADER-DAYS-DROPDOWN-LIST-{0..20}`.
- Captured states: `date-dropdown.png` (menu open), `date-changed.png` ("Gestern 10. Nov." selected; note the "Jetzt" pill moves to the axis edge as a jump-to-live affordance on non-current days).

### 3.2 Filters (icon with sliders, `title="Programmübersicht filter"`, id `EPG-HEADER-FILTER`)
- Opens a **right-side drawer as a native `<dialog>`** (`aria-controls="EPG-FILTER-OVERLAY"`): width **375px**, full height, slides over the content from the right, backdrop dims the page (~50% black). Close via ✕ button top-right.
- Contents (top→bottom): H2 "Filtern und Sortieren" (32px) → search input "Senderliste filtern" (with magnifier icon, filters channels by name) → 4 labeled select dropdowns (label left, 182px select right, h=44px):
  1. **Filter nach Genre**: Alle (374), Hauptprogramme (8), Regional, Unterhaltung (57), Sport (67), Kinder (17), Dokumentation (25), News (22), Kultur (7), Musik (18), Shopping (7), Lifestyle (12), Fremdsprachen (22), Erotik (5), Weitere (1) — numbers = channel counts
  2. **Filter nach Pakete**: Alle (374), Entertainment-Pakete, Sport-Pakete, Fremdsprachen-Pakete
  3. **Filter nach Weitere**: Alle (374), Free TV (222), Themensender (29), Abo | Pay TV (152), HD-Sender (316), UHD-Sender (5)
  4. **Sortieren nach**: Nummer (1-9) *(default)*, Nummer (9-1), Name (A-Z), Name (Z-A)
- **There are NO genre chips in the page UI** — category filtering is done exclusively through these drawer selects.
- Captured: `filters-open.png`.

### 3.3 Programme click / details
- Programme blocks are buttons with `aria-haspopup="dialog"` → the intended behavior is a **details dialog** (modal).
- **Environment caveat**: during this capture session the dialog never mounted (click registered, no DOM node created) — the details data request appears unreachable from this network (the site shows an error dialog "Angeforderte Seite aktuell nicht erreichbar" with a ✕ and a "Wiederholen" (retry) button when data requests fail; that dialog *was* observed at first load). The captured `detail-open.png` therefore shows the grid state, not the dialog. Expected dialog content (per Telekom MagentaTV pattern, **to verify**): programme title, time + channel header, cover/preview image, genre/duration metadata, description text, actions such as "Merken" (favorite), "Aufnehmen" (recording), "Erinnerung" (reminder), and a play/"Zum Video" CTA for on-demand titles.
- The header also contains an **"Info" icon button** (`id="EPG-DETAILS-INFO"`, `title="Info"`, 32×32) which appears in the icon row (visible at ≥1696px viewport width) and is the details affordance tied to the selected programme.

### 3.4 Timeline panning
- **‹ / › chevron buttons** (24×24, `id="EPG-HEADER-PREVIOUS"` / `EPG-HEADER-NEXT`, titles "frühere Programme" / "spätere Programme") sit at the left/right edges of the axis row and pan the timeline window.
- Panning is transform-based (no native horizontal scrollbar; content `translateX` changes). Dragging/trackpad scroll pans the 24h timeline; 21 days are reachable.
- **"Jetzt" pill**: click jumps the window back to the current time (`aria-label="zur aktuellen Zeit"`).

### 3.5 Header icon row (right side of nav bar)
| Icon | Element | Action |
|---|---|---|
| Sliders/filter | button `EPG-HEADER-FILTER` "Programmübersicht filter" | opens filter drawer |
| Grid/EPG | link `MENU-EPG` "Programmübersicht" | current page (active state) |
| Magnifier | link `MENU-SEARCH` "Suche" | navigates to search |
| Person | button `MENU-USER` "Benutzer" (`aria-haspopup="menu"`) | user menu |
| "Login" | text link | login |
| (Info) | button `EPG-DETAILS-INFO` "Info" | programme details affordance |
- Logo left: link `HEADER-LOGO`, aria "MagentaTV Startseite".

### 3.6 Channels / pagination
- **No pagination** ("Weitere Sender laden" does **not** exist): all 374 channels live in one virtualized list; scrolling the page streams rows in/out of the DOM.
- Clicking a channel cell (number/logo) → channel affordance; the gold **+** badge per channel cell = "add channel" (`add-channel.svg`).

### 3.7 Hover behavior
- Programme block: background **#1A1A1A → #262626** (lightens); text opacity stays 0.4; cursor pointer; no outline change on hover. Captured: `hover-programme.png`.

### 3.8 Cookie consent (first visit)
- **OneTrust** banner: centered rounded dialog ≈650×671px over a dark full-screen filter; text "Einwilligung in personalisierte Datenverarbeitung…"; buttons: **"Alles akzeptieren"** (primary), "Alles ablehnen", "Anpassen". Accepting stores consent and reveals the EPG data.

### 3.9 Responsive behavior
| Breakpoint | Differences |
|---|---|
| **1440×900 (desktop)** | full layout as §1; page-level vertical scroll (content 32k px); timeline 6px/min |
| **768×1024 (tablet)** | same timeline grid; EPG becomes an **internal scroll container** (app shell `height: viewport`, page height collapses to ≈1475px); timeline densifies to ≈4.15px/min (≈125px/30min); channel gutter ≈70px; all nav controls still visible |
| **390×844 (mobile)** | same timeline grid (NOT a list view); date combobox becomes a **full-width** control on its own row under the nav; grid/EPG icon hidden from nav; internal scroll container (page ≈1365px tall); timeline ≈3.9px/min (≈117px/30min); Telekom banner shows logo + "Jetzt Abo abschließen" stacked |

## 4. Screenshots saved (design/reference-magenta/)

| File | Content |
|---|---|
| `desktop-viewport.png` | 1440×900 viewport, top of page, consent accepted, prime-time window 18:30–23:00 |
| `desktop-fullpage.png` | full page stitched from 36 scrolled segments (1440×32,105; sticky bars appear once at top). Note: the live page virtualizes rows, so this is a scroll-stitch approximation |
| `tablet-768.png` | 768×1024 viewport |
| `mobile-390.png` | 390×844 viewport |
| `date-dropdown.png` | date combobox open with all 21 day options |
| `date-changed.png` | "Gestern 10. Nov." selected (grid re-rendered) |
| `filters-open.png` | filter drawer open (search + 4 selects) |
| `hover-programme.png` | programme block hover state (#262626) |
| `more-channels.png` | channel tail (Sendepause placeholders, INFO channel) + footer |
| `detail-open.png` | post-click state — **details dialog did not mount in this environment** (see §3.3) |

## 5. Implementation notes (HeroUI-based rebuild mapping)

Stable DOM anchors to copy from the original (class names are hashed CSS modules — **do not copy**):
ids `EPG-HEADER-DAYS-DROPDOWN-TOGGLE`, `EPG-HEADER-DAYS-DROPDOWN-LIST`, `EPG-HEADER-FILTER`, `EPG-FILTER-OVERLAY`,
`EPG-FILTER-OVERLAY-{GENRES|PACKAGES|OTHERS|SORT-BY}-DROPDOWN-TOGGLE`, `EPG-HEADER-PREVIOUS`, `EPG-HEADER-NEXT`,
`EPG-DETAILS-INFO`, `MENU-EPG`, `MENU-SEARCH`, `MENU-USER`, `HEADER-LOGO`; block buttons `id^="epg_pr_"`,
`button[aria-haspopup="dialog"]` per programme; ARIA roles combobox/listbox/option for the date picker.

| Original element | HeroUI primitive | Notes |
|---|---|---|
| Date combobox + listbox menu | `Select` (or `Autocomplete` for search) — not Tabs (original has no date strip) | 21 static options; render relative labels (Gestern/Heute/Morgen); custom item height 46px, dark menu bg #191919 |
| Filter drawer | `Drawer` placement `right`, size 375px, modal backdrop | contains `SearchField` + 4× `Select` |
| Genre/package/other/sort selects | `Select` | counts as item descriptions; default "Nummer (1-9)" |
| Programme block | plain `Button` (custom flat variant) inside a **custom virtualized timeline** (HeroUI `Table` is not a fit for a time-axis grid) | bg variants: default #0D0D0D, "running" #1A1A1A, hover #262626; title 20px/400 white/40 + meta 16px/400 white/40; square corners |
| Details dialog | `Modal` (`aria-haspopup="dialog"` intent) | content per §3.3 (to verify) |
| Error dialog ("Seite nicht erreichbar" + "Wiederholen") | `AlertDialog` with retry `Button` | also usable for failed data fetches |
| Cookie banner | `Modal`/`AlertDialog` with 3 actions | OneTrust equivalent |
| "Jetzt" pill / icon buttons | `Button` icon-only + `Tooltip` | 24×24 icons: sliders, grid, magnifier, person, chevrons ‹ ›, ✕ (use `CloseButton`) |
| "heute"-continuation & genre labels | `Chip` (dark, transparent, small) | original renders them as plain dim text, not chips — keep text-only if fidelity matters |
| Channel logo | `Image`/`Avatar` (42×17) | keep the `ngiss.t-online.de` image-service URL pattern if reusing real logos |
| Loading state | `Skeleton` rows (84px) | grid fetches data per day |
| Now-line + "Jetzt" | custom absolutely-positioned div + Button; HeroUI `ProgressBar` **not** needed (no progress bars exist in the original) | 2px #E20074 line spanning grid |
| Theme tokens | HeroUI dark theme; primary `#E20074`; surfaces #040404 / #0F0F0F / #191919 / #1A1A1A / #0D0D0D / #262626; text white + white/40 + #A5A5A5; convert to oklch variables via the HeroUI theming pipeline | font: TeleNeoWeb is proprietary — substitute a similar 400-weight grotesque |

Rebuild gotchas:
1. **Virtualize everything**: 374 rows × 8,640px-wide lanes; render only visible rows/time-window (the original keeps ~1–2 screens of rows in the DOM and uses `translateX` for time panning).
2. Sticky nav + sticky timeline axis + sticky 84px left channel column (3 sticky regions).
3. Scale differs per breakpoint (6 / 4.15 / 3.9 px per minute) — derive block width from duration × scale.
4. Programme text is 40%-opacity white, *regular* weight — do not use bold titles.
5. Keep the 1px black separators between blocks (grid aesthetic), radius 0.
