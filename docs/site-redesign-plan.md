# Site redesign plan (idea phase)

Status: planning only, nothing built yet. The current site (on this branch) is the working starting point.

## Goal

Make the public site feel like a playful showcase of what the studio builds, especially animation, without overwhelming visitors or making it harder to choose. Charm over chaos, in the spirit of isthereschool.com:

- Painted, seasonal scene illustrations
- Small looping character animations (like the footer dog-walk: a 12-frame animated WebP)
- Icons that "rise" in as content loads
- A calm layout with one bold color block per moment

## Overall structure

**One guided scroll on the homepage, with "windows" you can peek into, plus a handful of real pages behind it.**

- Homepage = a story you scroll through, with optional interactions along the way.
- Peek-in "windows" are a reusable component (in the story, the portfolio and the builder), not the whole site. No desktop/operating-system metaphor: it's clumsy on phones and hides prices.
- Real pages exist for depth and for people arriving from Google.

### Top menu (about four links)

Work · Pricing · Build your quote · About (plus Client login and a "Get a quote" button)

## The homepage: "Watch a website get built in a week"

The scroll is the week, so the structure itself carries the promise.

1. **Hero:** headline, illustrated scene, the "What's your business?" switch (see below).
2. **Monday, Kickoff:** a blank wireframe sketches itself in as you scroll.
3. **Tuesday, Branding:** a small window lets you tap colors and fonts and watch the sample site restyle.
4. **Wednesday, Build:** pages and features appear. Mini windows: a booking calendar you can tap, a gallery you can swipe, a scroll effect playing.
5. **Thursday, Review:** a miniature client portal. Click "Approve".
6. **Friday, Launch:** the site goes "live", with a small celebration and an Is There School-style illustration moment.
7. **Real work:** browser windows playing short muted loops of the actual sites (Walks for Lucy, Paybook, Is There School, Tycoon Universe, tidehere, iphere). Click one to open the case study.
8. **The four tiers:** each a colored card.
9. **"Build your own" teaser:** opens the builder page.
10. **Short FAQ, then the quote button.**

### "What's your business?" switch

A choice near the top: bakery, landscaper, salon, trainer, other. Every demo down the page reskins to that business. For example, the booking calendar books haircuts and the gallery shows cakes. Visitors see their own site, and it doubles as a demo of the theming the studio sells.

## Pages behind the homepage

| Page | Purpose |
|---|---|
| Work, with one page per case study | Depth and search; calmer, each in its project's own colors |
| Pricing | The four tiers in detail, plus the add-on lists |
| Build your quote | The interactive builder (below) |
| How it works | Onboarding, the one-week rule, the timeline rules |
| About | The studio and how AI-assisted development is used |
| FAQ | All questions |
| Northern Virginia web design | The local search page |

The client portal and admin dashboard stay calm (clients need to trust them), borrowing the palettes only for accents.

## Tiers (draft names and prices)

| Tier | Contents | Price | Timeline |
|---|---|---|---|
| Launch | Basic site | $150 | 5 business days |
| Grow | Basic site + 2 basic add-ons + 1 premium add-on | ~$450 | 5–10 business days |
| Signature | Full site + 5 basic add-ons + 3 premium add-ons | ~$1,200 | ~3 weeks |
| Build your own | Start from Launch, pick add-ons, the quote updates live | Adds up | Adds up |

- Add-on picks inside a tier are "choose any".
- Bundles priced a little below the same picks à la carte, so choosing a tier is the easy path.

### Basic add-ons (small, fit in the week)

Extra page · photo gallery · scroll animations · contact/lead form upgrades · appointment-request form · email notifications · reviews display · FAQ section · map / service area · simple blog or news · social links and feeds

### Premium add-ons (real systems)

Online booking with a calendar · Stripe payments or deposits · client accounts / portal · admin dashboard · online store · subscriptions · automated reminders · custom animated illustration (Is There School style) · AI feature · third-party integrations

## The "Build your quote" page

- Add-on cards in two groups, Basic and Premium. Each card has a tiny animated preview and its own color: this page is where the playful color variety lives.
- A sticky summary: running total, deposit amount, and the Mon–Fri week bar, which stretches when premium items push past a week.
- Tier shortcut buttons: picking Grow or Signature pre-fills the matching slots.
- "Send me this quote" opens the quote form already filled in.

## Visual rules (to keep variety coherent)

- One shared "window" frame for every demo (same corner radius, shadow, header bar); only the inside changes color.
- 6–8 named palettes reused across the site (e.g. sunset, mint, cobalt, grape, lemon, forest), plus the existing paper-and-ink base and orange accent.
- One type system and one set of motion timings everywhere.
- The Mon–Fri week bar stays as the recurring motif.
- Prefer short WebM/MP4 loops and live HTML/CSS over GIFs (GIFs are 5–10 times heavier).

## Things to avoid

- Hiding prices behind interactions; prices stay plainly visible.
- Locking or hijacking the scroll. Scrolling triggers things; it never controls speed.
- More than one call to action per section.
- Heavy animation slowing the first screen. Demos start when scrolled into view and pause off screen.
- Anything that only works with a mouse. With reduced motion turned on, every demo becomes a still.

## Open questions

1. Does Launch include 1 basic add-on in the $150, or is it "add one at its normal price"?
2. Final prices for Grow and Signature, and the size of the bundle discount.
3. Which add-ons are basic vs premium (the lists above are a draft).
4. Illustrations: generated images in the Is There School style (then animated and wired in), or simpler vector/CSS animations?
5. Tier names: keep Launch / Grow / Signature / Build your own, or choose others?
6. Which business types go in the "What's your business?" switch?
7. Should Tycoon Universe appear as a playable mini-window or just video?

## Suggested build order (when it's time)

1. Restructure the tiers and add-on data (basic vs premium) in the database and dashboard.
2. The "Build your quote" page with the live total and the link to the quote form.
3. The week-story homepage, section by section, with the business switch.
4. Video loops of the portfolio sites; illustrations and character animations.
5. Update Pricing and the case-study pages to match.
