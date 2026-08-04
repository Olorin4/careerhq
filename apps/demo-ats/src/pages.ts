// Pure HTML builders for the fictional "Northwind Robotics" ATS.
//
// These are deliberately dependency-free (no Hono, no I/O) and deterministic:
// later tasks (Greenhouse/Lever adapters, autoapply parsers) import them
// directly as fixtures instead of scraping a live server. The markup below
// mimics the real Greenhouse/Lever DOM shapes closely enough to exercise
// real-world parsing logic (field wrappers, aria-required, data-source
// markers, step markers, button ids) without depending on either vendor.

export interface DemoJob {
  id: string;
  title: string;
  company: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
</body>
</html>`;
}

export function indexPage(jobs: DemoJob[]): string {
  const items = jobs
    .map(
      (job) => `<li>
  <a href="/greenhouse/jobs/${escapeHtml(job.id)}">${escapeHtml(job.title)} (Greenhouse)</a>
  &mdash;
  <a href="/lever/jobs/${escapeHtml(job.id)}">${escapeHtml(job.title)} (Lever)</a>
</li>`,
    )
    .join("\n");
  return layout(
    "Northwind Robotics — Careers",
    `<h1>Northwind Robotics</h1>
<p>Open roles:</p>
<ul>
${items}
</ul>`,
  );
}

/**
 * Greenhouse-style multi-step application form.
 *
 * Step 1: identity (first/last name, email, phone, resume upload, LinkedIn url)
 * Step 2: details (work authorization select, visa sponsorship select,
 *         "why work here" textarea, legal attestation checkbox)
 * Step 3: voluntary demographics (gender radio, veteran status radio, both
 *         with a "Decline to self-identify" option)
 */
export function greenhousePage(job: DemoJob): string {
  const action = `/greenhouse/apply/${escapeHtml(job.id)}`;
  const body = `<div id="application_form" data-source="greenhouse" data-job-id="${escapeHtml(job.id)}">
  <h1>${escapeHtml(job.title)} at ${escapeHtml(job.company)}</h1>
  <form action="${action}" method="post" enctype="multipart/form-data">
    <section data-step="1">
      <h2>Your Information</h2>
      <div class="field">
        <label for="first_name">First Name</label>
        <input type="text" id="first_name" name="first_name" aria-required="true" required />
      </div>
      <div class="field">
        <label for="last_name">Last Name</label>
        <input type="text" id="last_name" name="last_name" aria-required="true" required />
      </div>
      <div class="field">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" aria-required="true" required />
      </div>
      <div class="field">
        <label for="phone">Phone</label>
        <input type="tel" id="phone" name="phone" />
      </div>
      <div class="field">
        <label for="resume">Resume/CV</label>
        <input type="file" id="resume" name="resume" aria-required="true" required />
      </div>
      <div class="field">
        <label for="linkedin_url">LinkedIn Profile</label>
        <input type="url" id="linkedin_url" name="linkedin_url" />
      </div>
      <button type="button" id="btn_next_1">Next</button>
    </section>
    <section data-step="2">
      <h2>Application Details</h2>
      <div class="field">
        <label for="work_authorization">Are you legally authorized to work in the country of this job posting? (Work Authorization)</label>
        <select id="work_authorization" name="work_authorization" aria-required="true" required>
          <option value="">-- Select --</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </div>
      <div class="field">
        <label for="visa_sponsorship">Will you now or in the future require visa sponsorship?</label>
        <select id="visa_sponsorship" name="visa_sponsorship" aria-required="true" required>
          <option value="">-- Select --</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </div>
      <div class="field">
        <label for="why_northwind">Why do you want to work at Northwind Robotics?</label>
        <textarea id="why_northwind" name="why_northwind" aria-required="true" required></textarea>
      </div>
      <div class="field">
        <label for="legal_attestation">
          <input type="checkbox" id="legal_attestation" name="legal_attestation" aria-required="true" required value="true" />
          I attest that the information provided in this application is true and complete.
        </label>
      </div>
      <button type="button" id="btn_next_2">Next</button>
    </section>
    <section data-step="3">
      <h2>Voluntary Self-Identification</h2>
      <p>Northwind Robotics is an equal opportunity employer. Completion of this section is voluntary.</p>
      <fieldset class="field">
        <legend>Gender</legend>
        <label><input type="radio" name="gender" value="male" /> Male</label>
        <label><input type="radio" name="gender" value="female" /> Female</label>
        <label><input type="radio" name="gender" value="nonbinary" /> Non-binary</label>
        <label><input type="radio" name="gender" value="decline" /> Decline to self-identify</label>
      </fieldset>
      <fieldset class="field">
        <legend>Veteran Status</legend>
        <label><input type="radio" name="veteran_status" value="veteran" /> I am a veteran</label>
        <label><input type="radio" name="veteran_status" value="not_veteran" /> I am not a veteran</label>
        <label><input type="radio" name="veteran_status" value="decline" /> Decline to self-identify</label>
      </fieldset>
      <button type="submit" id="btn_submit">Submit</button>
    </section>
  </form>
</div>`;
  return layout(`${job.title} at ${job.company}`, body);
}

/**
 * Lever-style single-page application form: every field lives on one page
 * with `cards[...]`-style field names, mirroring Lever's real posting form.
 */
export function leverPage(job: DemoJob): string {
  const action = `/lever/apply/${escapeHtml(job.id)}`;
  const body = `<h1>${escapeHtml(job.title)} at ${escapeHtml(job.company)}</h1>
<form class="application-form" data-source="lever" action="${action}" method="post" enctype="multipart/form-data">
  <div class="field">
    <label for="name">Full Name</label>
    <input type="text" id="name" name="name" aria-required="true" required />
  </div>
  <div class="field">
    <label for="email">Email</label>
    <input type="email" id="email" name="email" aria-required="true" required />
  </div>
  <div class="field">
    <label for="phone">Phone</label>
    <input type="tel" id="phone" name="phone" />
  </div>
  <div class="field">
    <label for="resume">Resume/CV</label>
    <input type="file" id="resume" name="resume" aria-required="true" required />
  </div>
  <div class="field">
    <label for="cards[urls][LinkedIn]">LinkedIn URL</label>
    <input type="url" id="cards[urls][LinkedIn]" name="cards[urls][LinkedIn]" />
  </div>
  <div class="field">
    <label for="cards[urls][Portfolio]">Portfolio URL</label>
    <input type="url" id="cards[urls][Portfolio]" name="cards[urls][Portfolio]" />
  </div>
  <div class="field">
    <label for="notice_period">Notice Period</label>
    <select id="notice_period" name="notice_period" aria-required="true" required>
      <option value="">-- Select --</option>
      <option value="immediate">Immediate</option>
      <option value="2_weeks">2 weeks</option>
      <option value="1_month">1 month</option>
      <option value="2_months">2 months or more</option>
    </select>
  </div>
  <div class="field">
    <label for="comments">Additional information</label>
    <textarea id="comments" name="comments"></textarea>
  </div>
  <button type="submit" id="btn_submit">Submit Application</button>
</form>`;
  return layout(`${job.title} at ${job.company}`, body);
}

/**
 * Signature-style attestation page: a Lever-style form with text and date
 * signature controls that trigger the legal_attestation blocker. Includes
 * a resume file input to avoid unsupported_file_control and login_required
 * blockers.
 */
export function signaturePage(job: DemoJob): string {
  const action = `/signature/apply/${escapeHtml(job.id)}`;
  const body = `<h1>${escapeHtml(job.title)} at ${escapeHtml(job.company)}</h1>
<form class="application-form" data-source="lever" action="${action}" method="post" enctype="multipart/form-data">
  <div class="field">
    <label for="name">Full Name</label>
    <input type="text" id="name" name="name" aria-required="true" required />
  </div>
  <div class="field">
    <label for="email">Email</label>
    <input type="email" id="email" name="email" aria-required="true" required />
  </div>
  <div class="field">
    <label for="phone">Phone</label>
    <input type="tel" id="phone" name="phone" />
  </div>
  <div class="field">
    <label for="resume">Resume/CV</label>
    <input type="file" id="resume" name="resume" aria-required="true" required />
  </div>
  <div class="field">
    <label for="cards[urls][LinkedIn]">LinkedIn URL</label>
    <input type="url" id="cards[urls][LinkedIn]" name="cards[urls][LinkedIn]" />
  </div>
  <div class="field">
    <label for="cards[urls][Portfolio]">Portfolio URL</label>
    <input type="url" id="cards[urls][Portfolio]" name="cards[urls][Portfolio]" />
  </div>
  <div class="field">
    <label for="signature_text">Type your full legal name to certify this application is true and complete</label>
    <input type="text" id="signature_text" name="signature_text" aria-required="true" required />
  </div>
  <div class="field">
    <label for="signature_date">Date of signature</label>
    <input type="date" id="signature_date" name="signature_date" aria-required="true" required />
  </div>
  <button type="submit" id="btn_submit">Submit Application</button>
</form>`;
  return layout(`${job.title} at ${job.company}`, body);
}

/**
 * Pre-ticked-consent fixture: a Lever-style form whose optional consent boxes
 * arrive from the server ALREADY CHECKED — the pattern real ATSs use for
 * marketing opt-ins and background-check consent, and the one case where
 * "the planner decided not to tick it" and "the box is untick*ed*" are not the
 * same thing.
 *
 * It exists so the driver can be proven to UNTICK a box whose planned value is
 * "" (no consent) rather than silently leaving the server's tick in place, and
 * to leave a box whose planned value is "true" ticked. Unchecked checkboxes are
 * simply absent from a form POST, so the submitted body is a direct, honest
 * read of what the browser actually sent.
 *
 * `background_check_consent` is pre-ticked AND optional: required boxes are
 * never the dangerous case (an empty answer blocks the review screen), whereas
 * an optional pre-ticked one submits fine either way.
 */
export function consentPage(job: DemoJob): string {
  const action = `/consent/apply/${escapeHtml(job.id)}`;
  const body = `<h1>${escapeHtml(job.title)} at ${escapeHtml(job.company)}</h1>
<form class="application-form" data-source="lever" action="${action}" method="post" enctype="multipart/form-data">
  <div class="field">
    <label for="name">Full Name</label>
    <input type="text" id="name" name="name" aria-required="true" required />
  </div>
  <div class="field">
    <label for="email">Email</label>
    <input type="email" id="email" name="email" aria-required="true" required />
  </div>
  <div class="field">
    <label for="resume">Resume/CV</label>
    <input type="file" id="resume" name="resume" aria-required="true" required />
  </div>
  <div class="field">
    <label for="legal_attestation">
      <input type="checkbox" id="legal_attestation" name="legal_attestation" aria-required="true" required value="true" />
      I attest that the information provided in this application is true and complete.
    </label>
  </div>
  <div class="field">
    <label for="background_check_consent">
      <input type="checkbox" id="background_check_consent" name="background_check_consent" value="true" checked />
      I consent to Northwind Robotics carrying out a background check.
    </label>
  </div>
  <div class="field">
    <label for="talent_pool_opt_in">
      <input type="checkbox" id="talent_pool_opt_in" name="talent_pool_opt_in" value="true" checked />
      Keep my details on file for future openings.
    </label>
  </div>
  <button type="submit" id="btn_submit">Submit Application</button>
</form>`;
  return layout(`${job.title} at ${job.company}`, body);
}

/**
 * Un-tickable-consent fixture: the same pre-ticked consent box as
 * `consentPage`, but `display:none` — the shape an ATS produces when a custom
 * widget renders the real control and hides the native input.
 *
 * Playwright cannot `uncheck()` a hidden control: it waits for actionability
 * and throws a `TimeoutError`. This page exists so that failure is exercised
 * for real, because collapsing it onto `kind: "timeout"` made a field-fill
 * failure indistinguishable from a submit click that may have landed, and
 * parked the attempt in NEEDS_RECONCILE over a form nothing was ever sent to.
 * Nothing here can be submitted successfully; that is the point.
 */
export function hiddenConsentPage(job: DemoJob): string {
  const action = `/hidden-consent/apply/${escapeHtml(job.id)}`;
  const body = `<h1>${escapeHtml(job.title)} at ${escapeHtml(job.company)}</h1>
<form class="application-form" data-source="lever" action="${action}" method="post" enctype="multipart/form-data">
  <div class="field">
    <label for="name">Full Name</label>
    <input type="text" id="name" name="name" aria-required="true" required />
  </div>
  <div class="field">
    <label for="email">Email</label>
    <input type="email" id="email" name="email" aria-required="true" required />
  </div>
  <div class="field">
    <label for="resume">Resume/CV</label>
    <input type="file" id="resume" name="resume" aria-required="true" required />
  </div>
  <div class="field" style="display:none">
    <label for="background_check_consent">
      <input type="checkbox" id="background_check_consent" name="background_check_consent" value="true" checked />
      I consent to Northwind Robotics carrying out a background check.
    </label>
  </div>
  <button type="submit" id="btn_submit">Submit Application</button>
</form>`;
  return layout(`${job.title} at ${job.company}`, body);
}

/**
 * Pause-and-return fixture: a CAPTCHA blocker that auto-apply cannot solve.
 */
export function captchaPage(job: DemoJob): string {
  const action = `/greenhouse/apply/${escapeHtml(job.id)}`;
  const body = `<h1>${escapeHtml(job.title)} at ${escapeHtml(job.company)}</h1>
<form action="${action}" method="post" enctype="multipart/form-data">
  <p>Please verify you are human before continuing.</p>
  <div class="g-recaptcha" data-sitekey="demo-ats-fake-sitekey"></div>
  <button type="submit" id="btn_submit">Submit</button>
</form>`;
  return layout(`Apply — ${job.title}`, body);
}

/**
 * Login-wall fixture: a page whose form is a username/password login,
 * simulating ATS instances that require an account before applying.
 */
export function loginPage(job: DemoJob): string {
  const body = `<h1>${escapeHtml(job.title)} at ${escapeHtml(job.company)}</h1>
<p>Please sign in to continue your application.</p>
<form action="/login/session" method="post">
  <div class="field">
    <label for="username">Username</label>
    <input type="text" id="username" name="username" aria-required="true" required />
  </div>
  <div class="field">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" aria-required="true" required />
  </div>
  <button type="submit" id="btn_login">Log In</button>
</form>`;
  return layout(`Sign In — ${job.title}`, body);
}

/**
 * Confirmation page shown after a successful POST. The confirmation id is
 * present both as visible text and as a `data-confirmation-id` attribute so
 * downstream parsers can key off either.
 */
export function confirmationPage(confirmationId: string): string {
  const body = `<div data-confirmation-id="${escapeHtml(confirmationId)}">
  <h1>Application received</h1>
  <p>Thank you for applying to Northwind Robotics.</p>
  <p>Confirmation ID: ${escapeHtml(confirmationId)}</p>
</div>`;
  return layout("Application received", body);
}
