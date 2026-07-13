---
name: frontend-design
description: Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one using WordPress, LiveCanvas, and Picostrap CSS. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults while utilizing Bootstrap 5 based utilities.
license: Complete terms in LICENSE.txt
---

# Frontend Design

Approach this as the design lead at a small studio known for giving every client a visual identity that could not be mistaken for anyone else's. This client has already rejected proposals that felt templated, and is paying for a distinctive point of view: make deliberate, opinionated choices about palette, typography, and layout that are specific to this brief, and take one real aesthetic risk you can justify.

## Ground it in the subject

If the brief does not pin down what the product or subject is, pin it yourself before designing: name one concrete subject, its audience, and the page's single job, and state your choice. If there's any information in your memory about the human's preferences, context about what they're building, or designs you've made before – use that as a hint. The subject's own world, its materials, instruments, artifacts, and vernacular, is where distinctive choices come from. Build with the brief's real content and subject matter throughout.

## WordPress, LiveCanvas & Picostrap CSS Constraints

This project specifically runs on **WordPress** using **LiveCanvas** and **Picostrap CSS** (which is based on **Bootstrap 5**).

1. **LiveCanvas HTML Structure**: All HTML you generate must be structured as valid LiveCanvas sections. Use typical Bootstrap 5 section and container structures that LiveCanvas relies on (e.g., `<section class="py-5">`, `<div class="container">`, `<div class="row">`, etc.).
2. **Picostrap CSS (Bootstrap 5)**: Do not write arbitrary custom CSS or use other frameworks like Tailwind. You must aggressively leverage Bootstrap 5 utility classes and components provided by Picostrap. Achieve your distinctive design and aesthetics through creative combinations of these utilities (e.g., colors, spacing, typography, grid, flexbox).
3. **WordPress Context**: Ensure any interactive elements or structure makes sense within a WordPress block or template environment.

## Design principles

For web designs, the hero is a thesis. Open with the most characteristic thing in the subject's world, in whatever form makes sense for it: a headline, an image, an animation, a live demo, an interactive moment. Be deliberate with your choice: a big number with a small label, supporting stats, and a gradient accent is the template answer, only use if that's truly the best option.

Typography carries the personality of the page. Pair the display and body faces deliberately, not the same families you would reach for on any other project, and set a clear type scale with intentional weights, widths, and spacing. Make the type treatment itself a memorable part of the design using Bootstrap's typography utilities.

Structure is information. Structural devices, numbering, eyebrows, dividers, labels, should encode something true about the content, not decorate it. Many generic designs use numbered markers (01 / 02 / 03), but that's only appropriate if the content actually is a sequence - like a real process or a typed timeline where order carries information the reader needs. Question if choices like numbered markers actually make sense before incorporating them. Use Bootstrap's grid system creatively to enforce this structure.

Leverage motion deliberately. Think about where and if animation can serve the subject: a page-load sequence, a scroll-triggered reveal, hover micro-interactions, ambient atmosphere. An orchestrated moment usually lands harder than scattered effects; choose what the direction calls for. However, sometimes less is more, and extra animation contributes to the feeling that the design is AI-generated.

Match complexity to the vision. Maximalist directions need elaborate execution; minimal directions need precision in spacing, type, and detail. Elegance is executing the chosen vision well. Use Bootstrap's spacing utilities carefully to achieve this balance.

Consider written content carefully. Often a design brief may not contain real content, and it's up to you to come up with copy. Copy can make a design feel as templated as the design itself. See the below section on writing for more guidance.

## Process: brainstorm, explore, plan, critique, build, critique again

For calibration: AI-generated design right now clusters around three looks: (1) a warm cream background (near #F4F1EA) with a high-contrast serif display and a terracotta accent; (2) a near-black background with a single bright acid-green or vermilion accent; (3) a broadsheet-style layout with hairline rules, zero border-radius, and dense newspaper-like columns. All three are legitimate for some briefs, but they are defaults rather than choices, and they appear regardless of subject. Where the brief pins down a visual direction, follow it exactly — the brief's own words always win, including when it asks for one of these looks. Where it leaves an axis free, don't spend that freedom on one of these defaults. Just like a human designer who's hired, there's often a careful balance between doing what you're good at and taking each project as a chance to experiment and learn.

Work in two passes. First, brainstorm a short design plan based on the human's design brief: create a compact token system with color, type, layout, and signature. Color: describe the palette using Bootstrap variables or color utilities if possible. Type: the typefaces for 2+ roles. Layout: a layout concept utilizing Bootstrap 5 grids, using one-sentence prose descriptions and ASCII wireframes to ideate and compare. Signature: the single unique element this page will be remembered by that embodies the brief in an appropriate way.

Then review that plan against the brief before building: if any part of it reads like the generic default you would produce for any similar page (work through a similar prompt to see if you arrive somewhere similar) rather than a choice made for this specific brief — revise that part, say what you changed and why. Only after you've confirmed the relative uniqueness of your design plan should you start to write the HTML code tailored for LiveCanvas, following the revised plan exactly and deriving every color and type decision from it.

When writing the code, be careful of structuring your LiveCanvas sections. Use Picostrap/Bootstrap 5 utility classes extensively.

Try to do a lot of this planning and iteration in your thinking, and only show ideas to the user when you have higher confidence it'll delight them.

## Restraint and self-critique

Spend your boldness in one place. Let the signature element be the one memorable thing, keep everything around it quiet and disciplined, and cut any decoration that does not serve the brief. Not taking a risk can be a risk itself! Build to a quality floor without announcing it: responsive down to mobile, visible keyboard focus, reduced motion respected. Critique your own work as you build, taking screenshots if your environment supports it – a picture is worth 1000 tokens. Consider Chanel's advice: before leaving the house, take a look in the mirror and remove one accessory. Human creators have memory and always try to do something new, so if you have a space to quickly jot down notes about what you've tried, it can help you in future passes.

## More on writing in design

Words appear in a design for one reason: to make it easier to understand, and therefore easier to use. They are design material, not decoration. Bring the same intentionality to copy that you would bring to spacing and color. Before writing anything, ask what the design needs to say, and how it can best be said to help the person navigate the experience.

Write from the end user's side of the screen. Name things by what people control and recognize, never by how the system is built. A person manages notifications, not webhook config. Describe what something does in plain terms rather than selling it. Being specific is always better than being clever.

Use active voice as default. A control should say exactly what happens when it's used: "Save changes," not "Submit." An action keeps the same name through the whole flow, so the button that says "Publish" produces a toast that says "Published." The vocabulary of an interface is the signposting for someone navigating the product. Cohesion and consistency are how people learn their way around.

Treat failure and emptiness as moments for direction, not mood. Explain what went wrong and how to fix it, in the interface's voice rather than a person's. Errors don't apologize, and they are never vague about what happened. An empty screen is an invitation to act.

Keep the register conversational and tuned: plain verbs, sentence case, no filler, with tone matched to the brand and the audience. Let each element do exactly one job. A label labels, an example demonstrates, and nothing quietly does double duty.

## 1. LiveCanvas & Picostrap Reference

**Minimal Valid LiveCanvas Template:**
LiveCanvas expects Bootstrap 5 structural classes. Always start with this hierarchy to ensure visual builder compatibility:
```html
<section class="py-5" id="unique-section-id">
  <div class="container">
    <div class="row">
      <div class="col-12 col-md-8 mx-auto">
        <!-- Content goes here -->
      </div>
    </div>
  </div>
</section>
```

**10 Impactful Bootstrap 5 Utility Classes:**
1. `display-1` to `display-6`: When you need a massive, opinionated hero heading, not a standard semantic `h1`.
2. `fw-bolder` / `fw-light`: When adjusting font weight creates structural hierarchy without changing font size.
3. `text-uppercase`: When small overline text needs to feel architectural and distinct from body copy.
4. `opacity-75` / `opacity-50`: When creating visual hierarchy in text without introducing muddy new colors.
5. `bg-dark` / `text-white`: When forcing a high-contrast inverse section to aggressively break page monotony.
6. `shadow-sm` / `shadow-lg`: When a floating element needs depth, but avoid standard `shadow` to prevent generic defaults.
7. `rounded-0` / `rounded-pill`: When making a stark choice between brutalist edges or overly soft shapes.
8. `g-0` (No gutters): When building flush, grid-spanning imagery or edge-to-edge brutalist layouts.
9. `min-vh-100`: When a hero section must command the entire viewport to establish immediate presence.
10. `ratio ratio-16x9`: When embedding media or images that must hold strict proportions across all breakpoints.

**Safe Picostrap CSS Variable Overrides:**
When injecting custom properties via the WordPress Customizer or root variables:
- **Color:** Override `--bs-primary` and `--bs-dark` to inject brand identity globally.
- **Spacing:** Tweak `--bs-spacer` to change the layout rhythm globally without fighting standard utility classes.
- **Typography:** Set `--bs-font-sans-serif` or `--bs-font-serif` using web-safe or enqueued Google fonts.

## 2. Worked Example

**Design Token Plan:**
- **Color:** Deep charcoal (`bg-dark`) with a single vibrant red accent (`text-danger`) for the CTA. Avoids the standard AI cream/terracotta look.
- **Type:** A tight, uppercase sans-serif eyebrow (`text-uppercase fw-bold`) paired with a massive, contrasting display heading (`display-2 fw-bolder`).
- **Layout:** Asymmetric split. Left-aligned heavy text (`col-lg-7`), overlapping a slightly offset image block on the right (`col-lg-5`).
- **Signature:** Strict brutalist edges (`rounded-0`, `border-2`) to convey rhythm and structure over generic softness.

**Final LiveCanvas HTML:**
```html
<section class="min-vh-100 d-flex align-items-center bg-dark text-white position-relative overflow-hidden py-5">
  <div class="container position-relative z-1">
    <div class="row align-items-center gx-5">
      <div class="col-12 col-lg-7 mb-5 mb-lg-0">
        <p class="text-uppercase fw-bold text-danger mb-3">Tanzstudio Berlin</p>
        <h1 class="display-2 fw-bolder mb-4 lh-1">Fühlen Sie den Rhythmus, nicht die Schritte.</h1>
        <p class="lead opacity-75 mb-5 w-75">Salsa und Bachata für Anfänger und Fortgeschrittene. Echtes Feuer, mitten in Kreuzberg.</p>
        <a href="#kurse" class="btn btn-danger btn-lg rounded-0 px-5 py-3 text-uppercase fw-bold">Kurse Finden</a>
      </div>
      <div class="col-12 col-lg-5">
        <div class="ratio ratio-1x1 shadow-lg border border-danger border-2 rounded-0">
          <img src="/wp-content/uploads/salsa-hero.jpg" class="object-fit-cover w-100 h-100 rounded-0" alt="Zwei Tänzer in Bewegung" loading="lazy">
        </div>
      </div>
    </div>
  </div>
</section>
```

**Rationale:**
- *Asymmetric alignment (`col-lg-7` / `col-lg-5`):* Avoids the standard, overused centered 50/50 split.
- *Strict borders & zero radius (`rounded-0`):* Feels intentional and edgy, completely rejecting soft, generic AI-rounded corners.
- *High-contrast stark palette (`bg-dark` with `text-danger`):* Immediately establishes a moody, intense atmosphere rather than default corporate warmth.

## 3. Anti-Patterns

1. **Mistake:** Writing inline CSS (`style="..."`) for spacing and colors.
   - **Fix:** Strictly use Bootstrap 5 utilities (`mt-5`, `text-primary`). Inline styles defeat Picostrap’s centralized variables and make the design brittle in LiveCanvas.
2. **Mistake:** Omitting the `.container` wrapper directly inside a `<section>`.
   - **Fix:** Always wrap rows in a `.container` or `.container-fluid`. Without it, LiveCanvas struggles to constrain content width, causing unpredictable bleeds on wide screens.
3. **Mistake:** Accepting standard Bootstrap components (like Cards) without utility modification.
   - **Fix:** Combine utilities (e.g., `border-0`, `rounded-0`, `bg-light`) to strip away the "default Bootstrap" feel and make the component bespoke to the brand.
4. **Mistake:** Failing to handle the WordPress Admin Bar overlap on full-height heroes.
   - **Fix:** Do not rely blindly on `top-0` or `min-vh-100` without testing logged-in states; ensure padding utilities (`pt-5`) provide enough clearance for the 32px admin bar.
5. **Mistake:** Generic, perfectly centered "Title + Subtitle + Button" hero sections.
   - **Fix:** Break the symmetry. Use offset columns (`offset-md-2`), asymmetric grid splits, or extreme typography scaling to create a definitive, opinionated point of view.
