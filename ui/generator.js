// AI-powered Page Object Model + spec file generator.
// Flow: explore URL with Playwright → send snapshot+story to Claude API → write files.
//
// Requires ANTHROPIC_API_KEY in the environment.

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const Anthropic = require('@anthropic-ai/sdk').default;

// ROOT honors the consumer's cwd when invoked via the CLI (`agentic-qa generate`)
// and falls back to this framework's own repo root for local dev (`npm run ui`).
const ROOT = process.env.AGENTIC_QA_CWD
  ? path.resolve(process.env.AGENTIC_QA_CWD)
  : path.resolve(__dirname, '..');

function safeSlug(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function safeFilename(name) {
  // Disallow path separators and traversal — file goes inside our target folder only.
  const base = path.basename(String(name || '')).replace(/[^a-z0-9._-]/gi, '');
  if (!base || base === '.' || base === '..') return null;
  return base;
}

async function explorePage(url, { onProgress } = {}) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  onProgress?.(`Navigating to ${url}…`);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });

  const title = await page.title();
  onProgress?.(`Loaded "${title}".`);

  // Accessibility snapshot — best representation of interactive elements / roles
  const aria = await page.accessibility.snapshot({ interestingOnly: true });

  // All interactive controls with role + accessible name
  const controls = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('input, textarea, select, button, a[href]')) {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || '';
      const role = el.getAttribute('role') || '';
      const id = el.id || '';
      const dataTest = el.getAttribute('data-test') || el.getAttribute('data-testid') || '';
      const name = el.getAttribute('name') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const label =
        (el.labels && el.labels[0] && el.labels[0].textContent?.trim()) ||
        el.getAttribute('aria-label') ||
        (el.textContent || '').trim().slice(0, 60);
      const href = el.getAttribute('href') || '';
      out.push({ tag, type, role, id, dataTest, name, placeholder, label, href });
    }
    return out.slice(0, 100);
  });

  // Try a no-op submit to capture validation messages (best-effort, swallows errors)
  let validationTexts = [];
  try {
    const submit = await page.$('button[type="submit"]') || await page.$('button:has-text("Next")') || await page.$('button:has-text("Sign In")') || await page.$('button:has-text("Submit")') || await page.$('button:has-text("Continue")');
    if (submit) {
      await submit.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(800);
      validationTexts = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('p, span, div'))
          .map(el => el.textContent?.trim() || '')
          .filter(t => t && t.length > 5 && t.length < 200 &&
            (/required|invalid|must be|please enter|at least/i).test(t));
      });
      validationTexts = [...new Set(validationTexts)].slice(0, 30);
      if (validationTexts.length) onProgress?.(`Captured ${validationTexts.length} validation message(s).`);
    }
  } catch (e) { /* best effort */ }

  await browser.close();
  return { url, title, aria, controls, validationTexts };
}

const SYSTEM_PROMPT = `You are a Playwright test generator for an Agentic QA framework that uses the Page Object Model (POM).

Framework conventions (must follow):
- All page objects extend the abstract BasePage in pages/BasePage.ts:
    import { type Page, expect } from '@playwright/test';
    export abstract class BasePage {
      abstract readonly url: string;
      constructor(protected readonly page: Page) {}
      async goto(): Promise<void> { await this.page.goto(this.url); }
      async expectLoaded(): Promise<void> { await expect(this.page).toHaveURL(this.url); }
    }
- Page objects live in pages/<feature-slug>/<PageName>Page.ts.
- Locators are readonly Locator properties initialized in the constructor.
- Action methods are intent-named (login, submit, clickContinue) — NOT selector-named.
- Specs live in tests/<feature-slug>/<scenario>.spec.ts.
- Specs MUST NOT contain raw selectors (no page.locator(...), no page.getBy*(…)). All DOM interaction goes through page-object methods/locators.
- Use role-based selectors in the POM (page.getByRole('textbox', { name: 'Email' }), page.getByRole('button', { name: 'Sign In' })).
- If credentials are needed, read them from process.env with safe placeholder fallbacks.

Output a JSON object with two arrays:
- pages: array of { filename, code } — TypeScript source for each page object
- tests: array of { filename, code } — TypeScript source for each spec file (one spec per acceptance criterion)

Filenames are basenames only (no path separators).`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          code: { type: 'string' },
        },
        required: ['filename', 'code'],
        additionalProperties: false,
      },
    },
    tests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          code: { type: 'string' },
        },
        required: ['filename', 'code'],
        additionalProperties: false,
      },
    },
  },
  required: ['pages', 'tests'],
  additionalProperties: false,
};

async function generateFiles({ slug, storyId, title, story, ac, creds, exploration, onProgress }) {
  const client = new Anthropic();

  const userMessage = `# Story: ${storyId} — ${title}

## Description
${story || '(none)'}

## Acceptance Criteria
${ac}

## Test Credentials (optional)
${creds || '(none — generate tests that read from process.env with placeholder defaults)'}

## Application URL
${exploration.url}

## Page Title
${exploration.title}

## Accessibility Snapshot (top of tree)
\`\`\`json
${JSON.stringify(exploration.aria, null, 2).slice(0, 8000)}
\`\`\`

## Interactive Controls Inventory
\`\`\`json
${JSON.stringify(exploration.controls, null, 2).slice(0, 6000)}
\`\`\`

## Captured Validation Messages
${exploration.validationTexts.length ? exploration.validationTexts.map(t => `- ${t}`).join('\n') : '(none captured)'}

## Generate
Feature slug: "${slug}"
- Page objects under pages/${slug}/ — one class per page involved (typically just one).
- One spec file per acceptance criterion under tests/${slug}/.
- Filenames are kebab-case basenames ending in .ts (page) or .spec.ts (test).
- Tests import their page object from "../../pages/${slug}/<PageName>Page".
`;

  onProgress?.('Calling Claude (claude-opus-4-8, adaptive thinking)…');

  // Streaming for long generations (max_tokens > ~16K can hit HTTP timeouts otherwise).
  let assembled = '';
  const stream = client.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  stream.on('text', (delta) => {
    assembled += delta;
    if (assembled.length % 2000 < delta.length) {
      onProgress?.(`Streaming response… ${assembled.length} chars`);
    }
  });

  const finalMessage = await stream.finalMessage();
  onProgress?.(`Response complete (${finalMessage.usage.output_tokens} output tokens).`);

  if (finalMessage.stop_reason === 'refusal') {
    throw new Error(`Claude refused to generate: ${finalMessage.stop_details?.explanation || 'no detail'}`);
  }

  const textBlock = finalMessage.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');

  let payload;
  try {
    payload = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error(`Failed to parse Claude response as JSON: ${err.message}`);
  }

  // Write files
  const pageDir = path.join(ROOT, 'pages', slug);
  const testDir = path.join(ROOT, 'tests', slug);
  fs.mkdirSync(pageDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });

  const written = { pages: [], tests: [] };

  for (const f of payload.pages || []) {
    const name = safeFilename(f.filename);
    if (!name) {
      onProgress?.(`Skipping invalid page filename: ${f.filename}`);
      continue;
    }
    const fp = path.join(pageDir, name);
    fs.writeFileSync(fp, f.code, 'utf8');
    written.pages.push(`pages/${slug}/${name}`);
    onProgress?.(`Wrote pages/${slug}/${name} (${f.code.length} bytes)`);
  }

  for (const f of payload.tests || []) {
    const name = safeFilename(f.filename);
    if (!name) {
      onProgress?.(`Skipping invalid test filename: ${f.filename}`);
      continue;
    }
    const fp = path.join(testDir, name);
    fs.writeFileSync(fp, f.code, 'utf8');
    written.tests.push(`tests/${slug}/${name}`);
    onProgress?.(`Wrote tests/${slug}/${name} (${f.code.length} bytes)`);
  }

  return { written, usage: finalMessage.usage };
}

module.exports = { explorePage, generateFiles, safeSlug };
