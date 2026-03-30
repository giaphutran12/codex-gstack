/**
 * Write commands — navigate and interact with pages (side effects)
 *
 * goto, back, forward, reload, click, fill, select, hover, type,
 * press, scroll, wait, viewport, cookie, header, useragent
 */

import type { BrowserManager } from './browser-manager';
import { findInstalledBrowsers, importCookies, listSupportedBrowserNames } from './cookie-import-browser';
import { validateNavigationUrl } from './url-validation';
import * as fs from 'fs';
import * as path from 'path';
import { TEMP_DIR, isPathWithin } from './platform';
import { modifyStyle, undoModification, resetModifications, getModificationHistory } from './cdp-inspector';

// Security: Path validation for screenshot output
const SAFE_DIRECTORIES = [TEMP_DIR, process.cwd()];

function validateOutputPath(filePath: string): void {
  const resolved = path.resolve(filePath);
  const isSafe = SAFE_DIRECTORIES.some(dir => isPathWithin(resolved, dir));
  if (!isSafe) {
    throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
  }
}

/** Common selectors for page clutter removal */
const CLEANUP_SELECTORS = {
  ads: [
    'ins.adsbygoogle', '[id^="google_ads"]', '[id^="div-gpt-ad"]',
    'iframe[src*="doubleclick"]', 'iframe[src*="googlesyndication"]',
    '[class*="ad-banner"]', '[class*="ad-wrapper"]', '[class*="ad-container"]',
    '[data-ad]', '[data-ad-slot]', '[class*="sponsored"]',
    '.ad', '.ads', '.advert', '.advertisement',
  ],
  cookies: [
    '[class*="cookie-consent"]', '[class*="cookie-banner"]', '[class*="cookie-notice"]',
    '[id*="cookie-consent"]', '[id*="cookie-banner"]', '[id*="cookie-notice"]',
    '[class*="consent-banner"]', '[class*="consent-modal"]',
    '[class*="gdpr"]', '[id*="gdpr"]',
    '[class*="CookieConsent"]', '[id*="CookieConsent"]',
    '#onetrust-consent-sdk', '.onetrust-pc-dark-filter',
    '[class*="cc-banner"]', '[class*="cc-window"]',
  ],
  sticky: [
    // Select fixed/sticky positioned elements (except navs and headers at top)
    // This is handled via JavaScript evaluation, not pure selectors
  ],
  social: [
    '[class*="social-share"]', '[class*="share-buttons"]', '[class*="share-bar"]',
    '[class*="social-widget"]', '[class*="social-icons"]',
    'iframe[src*="facebook.com/plugins"]', 'iframe[src*="platform.twitter"]',
    '[class*="fb-like"]', '[class*="tweet-button"]',
    '[class*="addthis"]', '[class*="sharethis"]',
  ],
};

export async function handleWriteCommand(
  command: string,
  args: string[],
  bm: BrowserManager
): Promise<string> {
  const page = bm.getPage();
  // Frame-aware target for locator-based operations (click, fill, etc.)
  const target = bm.getActiveFrameOrPage();
  const inFrame = bm.getFrame() !== null;

  switch (command) {
    case 'goto': {
      if (inFrame) throw new Error('Cannot use goto inside a frame. Run \'frame main\' first.');
      const url = args[0];
      if (!url) throw new Error('Usage: browse goto <url>');
      await validateNavigationUrl(url);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = response?.status() || 'unknown';
      return `Navigated to ${url} (${status})`;
    }

    case 'back': {
      if (inFrame) throw new Error('Cannot use back inside a frame. Run \'frame main\' first.');
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return `Back → ${page.url()}`;
    }

    case 'forward': {
      if (inFrame) throw new Error('Cannot use forward inside a frame. Run \'frame main\' first.');
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return `Forward → ${page.url()}`;
    }

    case 'reload': {
      if (inFrame) throw new Error('Cannot use reload inside a frame. Run \'frame main\' first.');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return `Reloaded ${page.url()}`;
    }

    case 'click': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse click <selector>');

      // Auto-route: if ref points to a real <option> inside a <select>, use selectOption
      const role = bm.getRefRole(selector);
      if (role === 'option') {
        const resolved = await bm.resolveRef(selector);
        if ('locator' in resolved) {
          const optionInfo = await resolved.locator.evaluate(el => {
            if (el.tagName !== 'OPTION') return null; // custom [role=option], not real <option>
            const option = el as HTMLOptionElement;
            const select = option.closest('select');
            if (!select) return null;
            return { value: option.value, text: option.text };
          });
          if (optionInfo) {
            await resolved.locator.locator('xpath=ancestor::select').selectOption(optionInfo.value, { timeout: 5000 });
            return `Selected "${optionInfo.text}" (auto-routed from click on <option>) → now at ${page.url()}`;
          }
          // Real <option> with no parent <select> or custom [role=option] — fall through to normal click
        }
      }

      const resolved = await bm.resolveRef(selector);
      try {
        if ('locator' in resolved) {
          await resolved.locator.click({ timeout: 5000 });
        } else {
          await target.locator(resolved.selector).click({ timeout: 5000 });
        }
      } catch (err: any) {
        // Enhanced error guidance: clicking <option> elements always fails (not visible / timeout)
        const isOption = 'locator' in resolved
          ? await resolved.locator.evaluate(el => el.tagName === 'OPTION').catch(() => false)
          : await target.locator(resolved.selector).evaluate(
              el => el.tagName === 'OPTION'
            ).catch(() => false);
        if (isOption) {
          throw new Error(
            `Cannot click <option> elements. Use 'browse select <parent-select> <value>' instead of 'click' for dropdown options.`
          );
        }
        throw err;
      }
      // Wait for network to settle (catches XHR/fetch triggered by clicks)
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      return `Clicked ${selector} → now at ${page.url()}`;
    }

    case 'fill': {
      const [selector, ...valueParts] = args;
      const value = valueParts.join(' ');
      if (!selector || !value) throw new Error('Usage: browse fill <selector> <value>');
      const resolved = await bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.fill(value, { timeout: 5000 });
      } else {
        await target.locator(resolved.selector).fill(value, { timeout: 5000 });
      }
      // Wait for network to settle (form validation XHRs)
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      return `Filled ${selector}`;
    }

    case 'select': {
      const [selector, ...valueParts] = args;
      const value = valueParts.join(' ');
      if (!selector || !value) throw new Error('Usage: browse select <selector> <value>');
      const resolved = await bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.selectOption(value, { timeout: 5000 });
      } else {
        await target.locator(resolved.selector).selectOption(value, { timeout: 5000 });
      }
      // Wait for network to settle (dropdown-triggered requests)
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      return `Selected "${value}" in ${selector}`;
    }

    case 'hover': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse hover <selector>');
      const resolved = await bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.hover({ timeout: 5000 });
      } else {
        await target.locator(resolved.selector).hover({ timeout: 5000 });
      }
      return `Hovered ${selector}`;
    }

    case 'type': {
      const text = args.join(' ');
      if (!text) throw new Error('Usage: browse type <text>');
      await page.keyboard.type(text);
      return `Typed ${text.length} characters`;
    }

    case 'press': {
      const key = args[0];
      if (!key) throw new Error('Usage: browse press <key> (e.g., Enter, Tab, Escape)');
      await page.keyboard.press(key);
      return `Pressed ${key}`;
    }

    case 'scroll': {
      const selector = args[0];
      if (selector) {
        const resolved = await bm.resolveRef(selector);
        if ('locator' in resolved) {
          await resolved.locator.scrollIntoViewIfNeeded({ timeout: 5000 });
        } else {
          await target.locator(resolved.selector).scrollIntoViewIfNeeded({ timeout: 5000 });
        }
        return `Scrolled ${selector} into view`;
      }
      await target.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      return 'Scrolled to bottom';
    }

    case 'wait': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse wait <selector|--networkidle|--load|--domcontentloaded>');
      if (selector === '--networkidle') {
        const timeout = args[1] ? parseInt(args[1], 10) : 15000;
        await page.waitForLoadState('networkidle', { timeout });
        return 'Network idle';
      }
      if (selector === '--load') {
        await page.waitForLoadState('load');
        return 'Page loaded';
      }
      if (selector === '--domcontentloaded') {
        await page.waitForLoadState('domcontentloaded');
        return 'DOM content loaded';
      }
      const timeout = args[1] ? parseInt(args[1], 10) : 15000;
      const resolved = await bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.waitFor({ state: 'visible', timeout });
      } else {
        await target.locator(resolved.selector).waitFor({ state: 'visible', timeout });
      }
      return `Element ${selector} appeared`;
    }

    case 'viewport': {
      const size = args[0];
      if (!size || !size.includes('x')) throw new Error('Usage: browse viewport <WxH> (e.g., 375x812)');
      const [w, h] = size.split('x').map(Number);
      await bm.setViewport(w, h);
      return `Viewport set to ${w}x${h}`;
    }

    case 'cookie': {
      const cookieStr = args[0];
      if (!cookieStr || !cookieStr.includes('=')) throw new Error('Usage: browse cookie <name>=<value>');
      const eq = cookieStr.indexOf('=');
      const name = cookieStr.slice(0, eq);
      const value = cookieStr.slice(eq + 1);
      const url = new URL(page.url());
      await page.context().addCookies([{
        name,
        value,
        domain: url.hostname,
        path: '/',
      }]);
      return `Cookie set: ${name}=****`;
    }

    case 'header': {
      const headerStr = args[0];
      if (!headerStr || !headerStr.includes(':')) throw new Error('Usage: browse header <name>:<value>');
      const sep = headerStr.indexOf(':');
      const name = headerStr.slice(0, sep).trim();
      const value = headerStr.slice(sep + 1).trim();
      await bm.setExtraHeader(name, value);
      const sensitiveHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'];
      const redactedValue = sensitiveHeaders.includes(name.toLowerCase()) ? '****' : value;
      return `Header set: ${name}: ${redactedValue}`;
    }

    case 'useragent': {
      const ua = args.join(' ');
      if (!ua) throw new Error('Usage: browse useragent <string>');
      bm.setUserAgent(ua);
      const error = await bm.recreateContext();
      if (error) {
        return `User agent set to "${ua}" but: ${error}`;
      }
      return `User agent set: ${ua}`;
    }

    case 'upload': {
      const [selector, ...filePaths] = args;
      if (!selector || filePaths.length === 0) throw new Error('Usage: browse upload <selector> <file1> [file2...]');

      // Validate all files exist before upload
      for (const fp of filePaths) {
        if (!fs.existsSync(fp)) throw new Error(`File not found: ${fp}`);
      }

      const resolved = await bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.setInputFiles(filePaths);
      } else {
        await target.locator(resolved.selector).setInputFiles(filePaths);
      }

      const fileInfo = filePaths.map(fp => {
        const stat = fs.statSync(fp);
        return `${path.basename(fp)} (${stat.size}B)`;
      }).join(', ');
      return `Uploaded: ${fileInfo}`;
    }

    case 'dialog-accept': {
      const text = args.length > 0 ? args.join(' ') : null;
      bm.setDialogAutoAccept(true);
      bm.setDialogPromptText(text);
      return text
        ? `Dialogs will be accepted with text: "${text}"`
        : 'Dialogs will be accepted';
    }

    case 'dialog-dismiss': {
      bm.setDialogAutoAccept(false);
      bm.setDialogPromptText(null);
      return 'Dialogs will be dismissed';
    }

    case 'cookie-import': {
      const filePath = args[0];
      if (!filePath) throw new Error('Usage: browse cookie-import <json-file>');
      // Path validation — prevent reading arbitrary files
      if (path.isAbsolute(filePath)) {
        const safeDirs = [TEMP_DIR, process.cwd()];
        const resolved = path.resolve(filePath);
        if (!safeDirs.some(dir => isPathWithin(resolved, dir))) {
          throw new Error(`Path must be within: ${safeDirs.join(', ')}`);
        }
      }
      if (path.normalize(filePath).includes('..')) {
        throw new Error('Path traversal sequences (..) are not allowed');
      }
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      const raw = fs.readFileSync(filePath, 'utf-8');
      let cookies: any[];
      try { cookies = JSON.parse(raw); } catch { throw new Error(`Invalid JSON in ${filePath}`); }
      if (!Array.isArray(cookies)) throw new Error('Cookie file must contain a JSON array');

      // Auto-fill domain from current page URL when missing (consistent with cookie command)
      const pageUrl = new URL(page.url());
      const defaultDomain = pageUrl.hostname;

      for (const c of cookies) {
        if (!c.name || c.value === undefined) throw new Error('Each cookie must have "name" and "value" fields');
        if (!c.domain) c.domain = defaultDomain;
        if (!c.path) c.path = '/';
      }

      await page.context().addCookies(cookies);
      return `Loaded ${cookies.length} cookies from ${filePath}`;
    }

    case 'cookie-import-browser': {
      // Two modes:
      // 1. Direct CLI import: cookie-import-browser <browser> --domain <domain> [--profile <profile>]
      // 2. Open picker UI: cookie-import-browser [browser]
      const browserArg = args[0];
      const domainIdx = args.indexOf('--domain');
      const profileIdx = args.indexOf('--profile');
      const profile = (profileIdx !== -1 && profileIdx + 1 < args.length) ? args[profileIdx + 1] : 'Default';

      if (domainIdx !== -1 && domainIdx + 1 < args.length) {
        // Direct import mode — no UI
        const domain = args[domainIdx + 1];
        const browser = browserArg || 'comet';
        const result = await importCookies(browser, [domain], profile);
        if (result.cookies.length > 0) {
          await page.context().addCookies(result.cookies);
        }
        const msg = [`Imported ${result.count} cookies for ${domain} from ${browser}`];
        if (result.failed > 0) msg.push(`(${result.failed} failed to decrypt)`);
        return msg.join(' ');
      }

      // Picker UI mode — open in user's browser
      const port = bm.serverPort;
      if (!port) throw new Error('Server port not available');

      const browsers = findInstalledBrowsers();
      if (browsers.length === 0) {
        throw new Error(`No Chromium browsers found. Supported: ${listSupportedBrowserNames().join(', ')}`);
      }

      const pickerUrl = `http://127.0.0.1:${port}/cookie-picker`;
      try {
        Bun.spawn(['open', pickerUrl], { stdout: 'ignore', stderr: 'ignore' });
      } catch {
        // open may fail silently — URL is in the message below
      }

      return `Cookie picker opened at ${pickerUrl}\nDetected browsers: ${browsers.map(b => b.name).join(', ')}\nSelect domains to import, then close the picker when done.`;
    }

    case 'style': {
      // style --undo [N] → revert modification
      if (args[0] === '--undo') {
        const idx = args[1] ? parseInt(args[1], 10) : undefined;
        await undoModification(page, idx);
        return idx !== undefined ? `Reverted modification #${idx}` : 'Reverted last modification';
      }

      // style <selector> <property> <value>
      const [selector, property, ...valueParts] = args;
      const value = valueParts.join(' ');
      if (!selector || !property || !value) {
        throw new Error('Usage: browse style <sel> <prop> <value> | style --undo [N]');
      }

      // Validate CSS property name
      if (!/^[a-zA-Z-]+$/.test(property)) {
        throw new Error(`Invalid CSS property name: ${property}. Only letters and hyphens allowed.`);
      }

      const mod = await modifyStyle(page, selector, property, value);
      return `Style modified: ${selector} { ${property}: ${mod.oldValue || '(none)'} → ${value} } (${mod.method})`;
    }

    case 'cleanup': {
      // Parse flags
      let doAds = false, doCookies = false, doSticky = false, doSocial = false;
      let doAll = false;

      if (args.length === 0) {
        throw new Error('Usage: browse cleanup [--ads] [--cookies] [--sticky] [--social] [--all]');
      }

      for (const arg of args) {
        switch (arg) {
          case '--ads': doAds = true; break;
          case '--cookies': doCookies = true; break;
          case '--sticky': doSticky = true; break;
          case '--social': doSocial = true; break;
          case '--all': doAll = true; break;
          default:
            throw new Error(`Unknown cleanup flag: ${arg}. Use: --ads, --cookies, --sticky, --social, --all`);
        }
      }

      if (doAll) {
        doAds = doCookies = doSticky = doSocial = true;
      }

      const removed: string[] = [];

      // Build selector list for categories to clean
      const selectors: string[] = [];
      if (doAds) selectors.push(...CLEANUP_SELECTORS.ads);
      if (doCookies) selectors.push(...CLEANUP_SELECTORS.cookies);
      if (doSocial) selectors.push(...CLEANUP_SELECTORS.social);

      if (selectors.length > 0) {
        const count = await page.evaluate((sels: string[]) => {
          let removed = 0;
          for (const sel of sels) {
            try {
              const els = document.querySelectorAll(sel);
              els.forEach(el => {
                (el as HTMLElement).style.display = 'none';
                removed++;
              });
            } catch {}
          }
          return removed;
        }, selectors);
        if (count > 0) {
          if (doAds) removed.push('ads');
          if (doCookies) removed.push('cookie banners');
          if (doSocial) removed.push('social widgets');
        }
      }

      // Sticky/fixed elements — handled separately with computed style check
      if (doSticky) {
        const stickyCount = await page.evaluate(() => {
          let removed = 0;
          const allElements = document.querySelectorAll('*');
          for (const el of allElements) {
            const style = getComputedStyle(el);
            if (style.position === 'fixed' || style.position === 'sticky') {
              const tag = el.tagName.toLowerCase();
              // Skip main nav/header elements
              if (tag === 'nav' || tag === 'header') continue;
              if (el.getAttribute('role') === 'navigation') continue;
              // Skip elements at the very top that look like navbars
              const rect = el.getBoundingClientRect();
              if (rect.top <= 10 && rect.height < 100 && tag !== 'div') continue;
              (el as HTMLElement).style.display = 'none';
              removed++;
            }
          }
          return removed;
        });
        if (stickyCount > 0) removed.push(`${stickyCount} sticky/fixed elements`);
      }

      if (removed.length === 0) return 'No clutter elements found to remove.';
      return `Cleaned up: ${removed.join(', ')}`;
    }

    case 'prettyscreenshot': {
      // Parse flags
      let scrollTo: string | undefined;
      let doCleanup = false;
      const hideSelectors: string[] = [];
      let viewportWidth: number | undefined;
      let outputPath: string | undefined;

      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--scroll-to' && i + 1 < args.length) {
          scrollTo = args[++i];
        } else if (args[i] === '--cleanup') {
          doCleanup = true;
        } else if (args[i] === '--hide' && i + 1 < args.length) {
          // Collect all following non-flag args as selectors to hide
          i++;
          while (i < args.length && !args[i].startsWith('--')) {
            hideSelectors.push(args[i]);
            i++;
          }
          i--; // Back up since the for loop will increment
        } else if (args[i] === '--width' && i + 1 < args.length) {
          viewportWidth = parseInt(args[++i], 10);
          if (isNaN(viewportWidth)) throw new Error('--width must be a number');
        } else if (!args[i].startsWith('--')) {
          outputPath = args[i];
        } else {
          throw new Error(`Unknown prettyscreenshot flag: ${args[i]}`);
        }
      }

      // Default output path
      if (!outputPath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        outputPath = `${TEMP_DIR}/browse-pretty-${timestamp}.png`;
      }
      validateOutputPath(outputPath);

      const originalViewport = page.viewportSize();

      // Set viewport width if specified
      if (viewportWidth && originalViewport) {
        await page.setViewportSize({ width: viewportWidth, height: originalViewport.height });
      }

      // Run cleanup if requested
      if (doCleanup) {
        const allSelectors = [
          ...CLEANUP_SELECTORS.ads,
          ...CLEANUP_SELECTORS.cookies,
          ...CLEANUP_SELECTORS.social,
        ];
        await page.evaluate((sels: string[]) => {
          for (const sel of sels) {
            try {
              document.querySelectorAll(sel).forEach(el => {
                (el as HTMLElement).style.display = 'none';
              });
            } catch {}
          }
          // Also hide fixed/sticky (except nav)
          for (const el of document.querySelectorAll('*')) {
            const style = getComputedStyle(el);
            if (style.position === 'fixed' || style.position === 'sticky') {
              const tag = el.tagName.toLowerCase();
              if (tag === 'nav' || tag === 'header') continue;
              if (el.getAttribute('role') === 'navigation') continue;
              (el as HTMLElement).style.display = 'none';
            }
          }
        }, allSelectors);
      }

      // Hide specific elements
      if (hideSelectors.length > 0) {
        await page.evaluate((sels: string[]) => {
          for (const sel of sels) {
            try {
              document.querySelectorAll(sel).forEach(el => {
                (el as HTMLElement).style.display = 'none';
              });
            } catch {}
          }
        }, hideSelectors);
      }

      // Scroll to target
      if (scrollTo) {
        // Try as CSS selector first, then as text content
        const scrolled = await page.evaluate((target: string) => {
          // Try CSS selector
          let el = document.querySelector(target);
          if (el) {
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            return true;
          }
          // Try text match
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null,
          );
          let node: Node | null;
          while ((node = walker.nextNode())) {
            if (node.textContent?.includes(target)) {
              const parent = node.parentElement;
              if (parent) {
                parent.scrollIntoView({ behavior: 'instant', block: 'center' });
                return true;
              }
            }
          }
          return false;
        }, scrollTo);

        if (!scrolled) {
          // Restore viewport before throwing
          if (viewportWidth && originalViewport) {
            await page.setViewportSize(originalViewport);
          }
          throw new Error(`Could not find element or text to scroll to: ${scrollTo}`);
        }
        // Brief wait for scroll to settle
        await page.waitForTimeout(300);
      }

      // Take screenshot
      await page.screenshot({ path: outputPath, fullPage: !scrollTo });

      // Restore viewport
      if (viewportWidth && originalViewport) {
        await page.setViewportSize(originalViewport);
      }

      const parts = ['Screenshot saved'];
      if (doCleanup) parts.push('(cleaned)');
      if (scrollTo) parts.push(`(scrolled to: ${scrollTo})`);
      parts.push(`: ${outputPath}`);
      return parts.join(' ');
    }

    default:
      throw new Error(`Unknown write command: ${command}`);
  }
}
