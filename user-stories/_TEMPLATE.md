# User Story: <STORY-ID> - <Short Title>

> Copy this file, rename it to `<STORY-ID>-<feature-slug>.md` (e.g. `LOGIN-001-user-authentication.md`),
> fill in the sections below, and then run the Express prompt from `QAEnd2EndPromptFile.md`.
> Anything marked **REQUIRED** must be present. Everything else is optional.

## Story Title (REQUIRED)
As a <user role>, I want to <do something> so that <benefit>.

## Story Description
<One paragraph describing the feature and why it exists.>

## Application URL (REQUIRED)
<https://example.com/the-page-to-test>

## Test Credentials (Optional)
Leave blank for negative-only testing. Provide real values or placeholders for positive flows.
- Username/email: `<email-or-username>`
- Password: `<password>`

> Tests will read these from environment variables when available:
> `APP_USER`, `APP_PASSWORD` (override names per-story as needed).

## Acceptance Criteria (REQUIRED)

### AC1: <Short title>
- GIVEN <preconditions>
- WHEN <action>
- THEN <expected outcome>
- AND <additional expected outcome>

### AC2: <Short title>
- GIVEN ...
- WHEN ...
- THEN ...

<!-- Add more ACs as needed -->

## Business Rules (Optional)
1. ...
2. ...

## Technical Notes (Optional)
- Browsers to target (default: chromium, firefox, webkit)
- Special wait/timing considerations
- Known UI quirks

## Definition of Done (Optional)
- [ ] All acceptance criteria have test cases
- [ ] Manual exploratory testing completed
- [ ] Automated test scripts pass (or are scaffolded with env-var creds)
- [ ] Test results documented
