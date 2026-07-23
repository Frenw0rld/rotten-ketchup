// Rotten Ketchup - content script
// Strategy: <media-scorecard> has an open shadow root. Inside
// the shadow, .scorecard-wrap > .score-wrap is a 2-column grid
// (.critics-score-wrap | .audience-score-wrap). We append a
// third grid cell (.rotten-ketchup-col) as a sibling of
// .audience-score-wrap so it sits next to the Popcornmeter
// column natively (no absolute positioning, no overlay, no
// fighting the host box).
//
// We also fall back to appending the column to the scorecard
// host (light DOM) if the shadow is closed or the wrap
// elements aren't present.

(function rottenKetchup() {
  const SCORECARD = "media-scorecard";
  const COLUMN_CLASS = "rotten-ketchup-col";
  const JSON_ID = "media-scorecard-json";

  // Exact class names RT uses today, in priority order. If an
  // exact match misses (RT renamed classes), findInShadow()
  // falls back to a substring match so the extension keeps
  // working and the debug log surfaces the drift.
  const SHADOW_SELECTORS = {
    scoreWrap:        ['.score-wrap',        '[class*="score-wrap"]'],
    descriptionWrap:  ['.description-wrap',  '[class*="description-wrap"]'],
    collapsedRow:     ['.collapsed-scores-row', '[class*="collapsed-scores-row"]'],
  };

  // Try each selector in `candidates` in order. Returns the
  // first match, or null. Logs via debug() which selector
  // actually hit so DOM drift is visible when rk-debug is on.
  function findInShadow(root, candidates) {
    if (!root) return null;
    for (let i = 0; i < candidates.length; i++) {
      const hit = root.querySelector(candidates[i]);
      if (hit) {
        debug("findInShadow hit", candidates[i]);
        return hit;
      }
    }
    debug("findInShadow missed all candidates", candidates);
    return null;
  }

  // Opt-in debug logging. Activated by either localStorage
  // ('rk-debug' === '1') or URL hash containing 'rk-debug'.
  // Off by default => zero user impact.
  function isDebug() {
    try {
      return (
        localStorage.getItem("rk-debug") === "1" ||
        (typeof location !== "undefined" &&
          (location.hash || "").indexOf("rk-debug") !== -1)
      );
    } catch (_) {
      return false;
    }
  }
  function debug(msg, ...args) {
    if (!isDebug()) return;
    try {
      console.warn("[RottenKetchup]", msg, ...args);
    } catch (_) {
      /* console gone, ignore */
    }
  }

  // Inject a tiny stylesheet into the scorecard's shadow root
  // (where the badge lives). It styles the empty/no-data
  // state so the muted indicator is visually distinct from
  // the live numbers. Light-DOM stylesheets can't cross
  // shadow boundaries, so the stylesheet must live in the
  // same shadow root as the badge.
  function injectStateStylesheet(shadowRoot) {
    if (!shadowRoot) return;
    if (shadowRoot.querySelector("#rotten-ketchup-styles")) return;
    const style = document.createElement("style");
    style.id = "rotten-ketchup-styles";
    style.textContent =
      "." +
      COLUMN_CLASS +
      '[data-rk-state="empty"] [data-rk-role="value"]{color:#888!important;}' +
      "." +
      COLUMN_CLASS +
      '[data-rk-state="empty"] [data-rk-role="reviews"]{color:#888!important;font-style:italic;cursor:default;pointer-events:none;}' +
      // Sticky column: RT always darkens the background image
      // when the sticky bar appears, so text is always white.
      "." +
      COLUMN_CLASS +
      '-sticky [data-rk-role="value"]{color:#fff;}' +
      "." +
      COLUMN_CLASS +
      '-sticky [data-rk-role="type"]{color:#fff;opacity:0.7;}' +
      "." +
      COLUMN_CLASS +
      '-sticky [data-rk-role="reviews"]{color:#fff;}' +
      "." +
      COLUMN_CLASS +
      '-sticky[data-rk-state="empty"] [data-rk-role="value"]{color:#fff;opacity:0.5;}' +
      "." +
      COLUMN_CLASS +
      '-sticky[data-rk-state="empty"] [data-rk-role="reviews"]{color:#fff;opacity:0.5;font-style:italic;cursor:default;pointer-events:none;}';
    shadowRoot.appendChild(style);
  }

  // ---- Parse + compute ----
  function parseScorecardJson() {
    const el = document.getElementById(JSON_ID);
    if (!el) return null;
    const text = (el.textContent || "").trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      console.warn("[RottenKetchup] Failed to parse", JSON_ID, e);
      return null;
    }
  }

  // Read the relevant numbers out of the parsed JSON.
  // The audience (Popcornmeter) data lives under `overlay`:
  //   overlay.audienceAll     = all-audience (verified + unverified)
  //   overlay.audienceVerified = verified-audience (ticket purchasers)
  // Both have `likedCount` and `notLikedCount`.
  function readAudienceCounts(data) {
    const overlay = data?.overlay;
    if (!overlay) return null;
    const all = overlay.audienceAll;
    const verified = overlay.audienceVerified;
    if (!all || !verified) return null;
    return {
      allLikes: Number(all.likedCount) || 0,
      allDislikes: Number(all.notLikedCount) || 0,
      verifiedLikes: Number(verified.likedCount) || 0,
      verifiedDislikes: Number(verified.notLikedCount) || 0,
    };
  }

  // Pull score = like % among unverified (non-ticket) voters.
  //   unverifiedLikes    = allLikes    - verifiedLikes
  //   unverifiedDislikes = allDislikes - verifiedDislikes
  //   pullPct            = unverifiedLikes / (unverifiedLikes + unverifiedDislikes) * 100
  // Returns an object with hasPullData: false if there are no
  // unverified votes.
  function computePull(counts) {
    if (!counts) return null;
    const unverifiedLikes = Math.max(0, counts.allLikes - counts.verifiedLikes);
    const unverifiedDislikes = Math.max(
      0,
      counts.allDislikes - counts.verifiedDislikes,
    );
    const unverifiedTotal = unverifiedLikes + unverifiedDislikes;
    if (unverifiedTotal === 0) {
      return {
        unverifiedLikes,
        unverifiedDislikes,
        unverifiedTotal,
        pullPct: null, // hide the badge
        displayPct: null,
        hasPullData: false,
      };
    }
    const pullPct = (unverifiedLikes / unverifiedTotal) * 100;
    return {
      unverifiedLikes,
      unverifiedDislikes,
      unverifiedTotal,
      pullPct,
      displayPct: Math.round(pullPct),
      hasPullData: true,
    };
  }

  function runParser() {
    const data = parseScorecardJson();
    if (!data) {
      console.warn(`[RottenKetchup] #${JSON_ID} not found or empty`);
      window.__rottenKetchup = { ok: false, reason: "no-json" };
      return;
    }
    const counts = readAudienceCounts(data);
    if (!counts) {
      console.warn(
        "[RottenKetchup] JSON found but audience counts missing; " +
          "available keys:",
        Object.keys(data),
      );
      window.__rottenKetchup = { ok: false, reason: "no-counts" };
      return;
    }
    const pull = computePull(counts);
    window.__rottenKetchup = { ok: true, data, counts, pull };
    debug("parser ok", {
      pullPct: pull.pullPct,
      unverifiedTotal: pull.unverifiedTotal,
    });

    // Refresh the badge in place if it was already injected.
    // The badge lives inside the scorecard's shadow root, so
    // a light-DOM querySelector can't find it; the references
    // are stashed on window.__rottenKetchup by place() instead.
    const live = window.__rottenKetchup;
    if (live?.badge) applyDataToBadge(live.badge, pull, counts);
    if (live?.stickyBadge) applyDataToBadge(live.stickyBadge, pull, counts);
  }

  // ---- Badge injection ----
  function findAudienceScorecard() {
    return (
      document.querySelector(`${SCORECARD}[data-rk-scored="audience"]`) ||
      Array.from(document.querySelectorAll(SCORECARD)).find((el) => {
        if (!/Popcornmeter/i.test(el.textContent || "")) return false;
        const r = el.getBoundingClientRect();
        // Prefer the scorecard that's in the upper viewport
        // (the hero one near the poster), not the lower one
        // in the "About Tomatometer" panel.
        return r.top > -1000 && r.top < 2000;
      }) ||
      document.querySelector(SCORECARD)
    );
  }

  function buildColumn() {
    const col = document.createElement("div");
    col.className = COLUMN_CLASS;
    col.setAttribute("data-rk", "test-column");
    col.style.cssText = [
      "display:flex",
      "flex-direction:row",
      "align-items:center",
      "justify-content:flex-start",
      "gap:10px",
      "color:#222",
      "min-width:120px",
      "box-sizing:border-box",
      "margin-left:8px",
      "padding:6px 10px",
      "font:var(--franklinGothicMedium),system-ui,sans-serif",
    ].join(";");

    // Image on the left.
    const img = document.createElement("img");
    img.src =
      (typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.getURL &&
        chrome.runtime.getURL("icons/icon48.png")) ||
      "icons/icon48.png";
    img.alt = "Rotten Ketchup";
    img.style.cssText =
      "width:40px;height:40px;display:block;flex:0 0 auto;align-self:start";

    // Text stack on the right.
    const text = document.createElement("div");
    text.style.cssText =
      "display:flex;flex-direction:column;align-items:flex-start";

    const value = document.createElement("div");
    value.setAttribute("data-rk-role", "value");
    value.textContent = "—";
    value.style.cssText = "font-size:22px;font-weight:500;margin-bottom:4px";

    const type = document.createElement("div");
    type.setAttribute("data-rk-role", "type");
    type.textContent = "Censored";
    type.style.cssText = "font-size:12px;letter-spacing:0.2px";

    const reviews = document.createElement("a");
    reviews.setAttribute("data-rk-role", "reviews");
    reviews.href =
      "https://www.reddit.com/r/KotakuInAction/comments/1v1ow9s/rotten_tomatoes_says_the_odyssey_has_a_97/";
    reviews.target = "_blank";
    reviews.textContent = "—";
    reviews.style.cssText =
      "font-size:12px;color:var(--blueLink);font-weight:500;margin-top:2px;text-decoration:none";

    reviews.addEventListener("mouseenter", () => {
      reviews.style.textDecoration = "underline";
      reviews.style.color = "var(--blueHover)";
    });

    reviews.addEventListener("mouseleave", () => {
      reviews.style.textDecoration = "none";
      reviews.style.color = "var(--blueLink)";
    });

    text.appendChild(value);
    text.appendChild(type);
    text.appendChild(reviews);

    col.appendChild(img);
    col.appendChild(text);
    return col;
  }

  // Format an integer with a thousands separator (e.g. 1487 -> "1,487").
  function formatCount(n) {
    return Number(n || 0).toLocaleString("en-US");
  }

  // Build the compact column for the sticky/collapsed hero bar.
  // Mirrors the structure of the existing .collapsed-scores-col
  // audience column (icon + score / link / label stack) so it
  // sits next to it natively. The duplication with buildColumn
  // is intentional: the two variants differ in icon path, hover
  // handlers, layout direction, and inline styling. Consolidating
  // them behind a shared factory would add abstraction for only
  // two call sites, which AGENTS.md (simplicity-first) explicitly
  // counsels against.
  function buildStickyColumn() {
    const col = document.createElement("div");
    col.className =
      `${COLUMN_CLASS} ${COLUMN_CLASS}-sticky collapsed-scores-col`;
    col.setAttribute("data-rk", "sticky-column");
    col.style.cssText =
      "display:flex;flex-direction:row;align-items:center;gap:8px;margin-left:16px";

    // Icon on the left, matching the size used by the existing
    // .collapsed-audience-icon wrapper.
    const iconWrap = document.createElement("div");
    iconWrap.className = "collapsed-audience-icon";
    iconWrap.style.cssText = "flex:0 0 auto;display:flex;align-self:start";

    const img = document.createElement("img");
    img.src =
      (typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.getURL &&
        chrome.runtime.getURL("icons/icon48glow.png")) ||
      "icons/icon48glow.png";
    img.alt = "Rotten Ketchup";
    img.style.cssText = "width:48px;height:48px;display:block";
    iconWrap.appendChild(img);

    // Stack: value / reviews / type. justify-content (not
    // align-content) distributes the children on the main
    // axis; align-content only applies when flex-wrap allows
    // multi-line, which we don't.
    const details = document.createElement("div");
    details.className = "collapsed-score-details";
    details.style.cssText =
      "display:flex;flex-direction:column;justify-content:space-between;color:#fff;min-height:100%";

    const value = document.createElement("div");
    value.setAttribute("data-rk-role", "value");
    value.textContent = "—";
    value.style.cssText = "font-size:22px;font-weight:500";

    const reviews = document.createElement("a");
    reviews.setAttribute("data-rk-role", "reviews");
    reviews.href =
      "https://www.reddit.com/r/KotakuInAction/comments/1v1ow9s/rotten_tomatoes_says_the_odyssey_has_a_97/";
    reviews.target = "_blank";
    reviews.textContent = "—";
    reviews.style.cssText =
      "font-size:12px;font-weight:400;text-decoration:none;color:#70a5ff";

    reviews.addEventListener("mouseenter", () => {
      reviews.style.textDecoration = "underline #326AF6";
    });
    reviews.addEventListener("mouseleave", () => {
      reviews.style.textDecoration = "none";
    });

    const type = document.createElement("div");
    type.setAttribute("data-rk-role", "type");
    type.textContent = "Censored";
    type.style.cssText = "font-size:12px;letter-spacing:0.2px;color:#fff";

    details.appendChild(value);
    details.appendChild(reviews);
    details.appendChild(type);

    col.appendChild(iconWrap);
    col.appendChild(details);
    return col;
  }

  // When `pull.hasPullData === false`, render a
  // muted "no independent votes" indicator instead of hiding
  // the column, so users understand why the third column is
  // empty. Visibility is toggled via a `data-rk-state`
  // attribute + a tiny stylesheet so the inline flex layout
  // from buildColumn is never disturbed.
  function applyDataToBadge(col, pull, counts) {
    if (!col) return;
    const value = col.querySelector('[data-rk-role="value"]');
    const reviews = col.querySelector('[data-rk-role="reviews"]');
    if (!pull || !counts) {
      // No data yet: keep the placeholder dashes so the column
      // is still visible during early paint.
      if (value) value.textContent = "—";
      if (reviews) {
        reviews.textContent = "—";
      }
      col.setAttribute("data-rk-state", "loading");
      return;
    }
    if (!pull.hasPullData) {
      // Render an empty-state placeholder instead of hiding
      // the column, so users understand why the third column
      // is empty.
      if (value) value.textContent = "—";
      if (reviews) {
        reviews.textContent = "No independent votes yet";
        if (reviews.href) {
          // Strip the href so the "no votes" placeholder isn't
          // a clickable dead link, but only if the link was
          // already set.
          reviews.removeAttribute("href");
        }
      }
      col.setAttribute("data-rk-state", "empty");
      return;
    }
    col.setAttribute("data-rk-state", "ready");
    if (value) value.textContent = `${pull.displayPct}%`;
    if (reviews) {
      reviews.textContent = `${formatCount(pull.unverifiedTotal)} Reviews`;
      // The href is set at build time (Reddit attribution link
      // in buildColumn / buildStickyColumn). Don't overwrite it
      // here, otherwise the attribution is lost on every refresh.
    }
  }

  function place() {
    // The column lives inside the scorecard's shadow root, so
    // a plain light-DOM querySelector won't find it. We use
    // the stashed reference on window.__rottenKetchup.badge
    // (set below) as the idempotency marker.
    if (window.__rottenKetchup?.badge) return true;
    const card = findAudienceScorecard();
    if (!card) return false;
    card.setAttribute("data-rk-scored", "audience");

    const col = buildColumn();

    // Stash a reference to the badge so runParser() can find
    // it after the fact. The badge lives inside the scorecard's
    // shadow root, so a light-DOM querySelector can't reach it.
    window.__rottenKetchup = window.__rottenKetchup || {};
    window.__rottenKetchup.badge = col;

    // Apply whatever data is already on window.__rottenKetchup
    // (in case the parser ran before the scorecard was found).
    const existing = window.__rottenKetchup;
    if (existing?.ok) {
      applyDataToBadge(col, existing.pull, existing.counts);
    } else {
      applyDataToBadge(col, null, null);
    }

    let injected = false;
    let shadowRoot = null;

    // Preferred: insert as a sibling of .audience-score-wrap
    // *before* .description-wrap inside the open shadow root,
    // so it becomes a 3rd cell in the same row as the
    // Popcornmeter column, and the description stays on the
    // row below. We also force .score-wrap into a 3-column
    // grid (and .description-wrap to span all 3 columns on
    // its own row) so the three score columns truly share
    // one row, regardless of the original 2-col layout.
    try {
      shadowRoot = card.shadowRoot;
      if (shadowRoot) {
        // Inject the empty-state stylesheet into this
        // shadow root so the data-rk-state rules can
        // actually reach the badge.
        injectStateStylesheet(shadowRoot);
        const scoreWrap = findInShadow(shadowRoot, SHADOW_SELECTORS.scoreWrap);
        if (scoreWrap) {
          const descriptionWrap = findInShadow(scoreWrap, SHADOW_SELECTORS.descriptionWrap);

          // Promote .score-wrap to a 3-column grid so all
          // three score cells (critics / audience / us) share
          // one row.
          scoreWrap.style.display = "grid";
          scoreWrap.style.gridTemplateColumns =
            "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)";
          scoreWrap.style.columnGap = "8px";
          scoreWrap.style.alignItems = "center";

          if (descriptionWrap) {
            // Description stays on its own row, spanning all
            // three columns.
            descriptionWrap.style.gridColumn = "1 / -1";
            scoreWrap.insertBefore(col, descriptionWrap);
          } else {
            scoreWrap.appendChild(col);
          }
          injected = true;
        }
      }
    } catch (e) {
      debug("scorecard shadow injection failed", e);
    }

    // Fallback: append to the scorecard host (light DOM).
    if (!injected) card.appendChild(col);

    // Also build + inject the compact column for the sticky
    // .media-hero.collapsed bar (visible while scrolling). It
    // mirrors the existing .collapsed-scores-col audience
    // column structure. The sticky row lives in a *different*
    // element's shadow root (not <media-scorecard>); on this
    // page that element is the <media-hero> custom element,
    // which we can query directly (O(1)) instead of scanning
    // every shadow root in the document.
    function findStickyRow() {
      // Cache the found host on window so we don't re-scan.
      const cached =
        window.__rottenKetchup?.stickyHost;
      if (cached?.isConnected) {
        try {
          const row = findInShadow(cached.shadowRoot, SHADOW_SELECTORS.collapsedRow);
          if (row) return row;
        } catch (e) {
          debug("cached sticky host shadow probe failed", e);
        }
      }
      // Fast path: <media-hero> is a registered custom element,
      // so document.querySelector reaches it directly.
      const hero = document.querySelector("media-hero");
      if (hero?.shadowRoot) {
        try {
          const row = findInShadow(hero.shadowRoot, SHADOW_SELECTORS.collapsedRow);
          if (row) {
            window.__rottenKetchup = window.__rottenKetchup || {};
            window.__rottenKetchup.stickyHost = hero;
            return row;
          }
        } catch (e) {
          debug("media-hero shadow probe failed", e);
        }
      }
      // Last-resort fallback: scan every element's shadow
      // root. Only runs when <media-hero> isn't on the page
      // (older RT markup). 674 shadow roots on the current
      // page, so this is the slow path. The downstream
      // findInShadow() calls already log hit/miss for each
      // candidate, so no separate debug() line is needed
      // here.
      const all = document.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (!el?.shadowRoot) continue;
        try {
          const row = findInShadow(el.shadowRoot, SHADOW_SELECTORS.collapsedRow);
          if (row) {
            window.__rottenKetchup = window.__rottenKetchup || {};
            window.__rottenKetchup.stickyHost = el;
            return row;
          }
        } catch (_e) {
          /* closed shadow, skip */
        }
      }
      return null;
    }

    function injectStickyColumn() {
      // Idempotency: don't inject twice.
      if (window.__rottenKetchup?.stickyBadge) {
        return true;
      }
      const stickyRow = findStickyRow();
      if (!stickyRow) return false;
      const stickyCol = buildStickyColumn();
      stickyRow.appendChild(stickyCol);
      window.__rottenKetchup = window.__rottenKetchup || {};
      window.__rottenKetchup.stickyBadge = stickyCol;
      const cur = window.__rottenKetchup;
      if (cur?.ok) {
        applyDataToBadge(stickyCol, cur.pull, cur.counts);
      } else {
        applyDataToBadge(stickyCol, null, null);
      }
      return true;
    }

    let stickyInjected = false;
    try {
      stickyInjected = injectStickyColumn();
    } catch (e) {
      debug("injectStickyColumn threw", e);
    }

    // .media-hero.collapsed is only present in the DOM after
    // the user scrolls. Watch the document so we catch the
    // hero element being added dynamically (and any new shadow
    // hosts being attached).
    if (!stickyInjected) {
      try {
        const stickyObs = new MutationObserver(() => {
          if (injectStickyColumn()) stickyObs.disconnect();
        });
        stickyObs.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
        window.__rottenKetchup = window.__rottenKetchup || {};
        window.__rottenKetchup.stickyObserver = stickyObs;
        setTimeout(() => stickyObs.disconnect(), 60000);
      } catch (e) {
        debug("sticky observer setup failed", e);
      }
    }

    card.setAttribute("data-rk-injected", "true");
    return true;
  }

  // ---- SPA-safe re-scan on client-side navigation ----
  // RT is a single-page app: navigating between movie pages
  // changes the URL via history.pushState without a full page
  // reload, so the old <media-scorecard> is torn down and a
  // new one is created. We need to reset our cached state and
  // re-run place()/runParser() on each navigation, otherwise
  // the new scorecard never gets a badge.

  function resetForNavigation() {
    // Drop cached data + badge reference so place()/runParser()
    // treat this as a fresh page.
    if (window.__rottenKetchup) {
      // Detach the old badge from its parent (light or shadow
      // DOM) if it's still attached. The old shadow root may
      // be gone with the old scorecard, so guard against that.
      const oldBadge = window.__rottenKetchup.badge;
      if (oldBadge?.parentNode) {
        try {
          oldBadge.parentNode.removeChild(oldBadge);
        } catch (e) {
          debug("old badge detach failed", e);
        }
      }
      // Same for the sticky/collapsed hero column.
      const oldSticky = window.__rottenKetchup.stickyBadge;
      if (oldSticky?.parentNode) {
        try {
          oldSticky.parentNode.removeChild(oldSticky);
        } catch (e) {
          debug("old sticky detach failed", e);
        }
      }
      // Disconnect the sticky-row observer so it doesn't fire
      // after the scorecard is gone.
      const oldStickyObs = window.__rottenKetchup.stickyObserver;
      if (oldStickyObs) {
        try {
          oldStickyObs.disconnect();
        } catch (e) {
          debug("sticky observer disconnect failed", e);
        }
      }
    }
    window.__rottenKetchup = null;
    // Remove our markers from any remaining scorecards so
    // findAudienceScorecard can pick the new one and place()
    // can re-inject.
    try {
      document
        .querySelectorAll(
          `${SCORECARD}[data-rk-scored], ${SCORECARD}[data-rk-injected]`,
        )
        .forEach((el) => {
          el.removeAttribute("data-rk-scored");
          el.removeAttribute("data-rk-injected");
        });
    } catch (e) {
      debug("marker cleanup failed", e);
    }
  }

  function startScorecardObserver() {
    if (
      document.querySelector(SCORECARD) ||
      (window.__rottenKetchup?.badge)
    ) {
      return;
    }
    const obs = new MutationObserver(() => {
      if (place()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 30000);
  }

  function startJsonObserver() {
    if (document.getElementById(JSON_ID)) {
      runParser();
      return;
    }
    const jsonObs = new MutationObserver(() => {
      if (document.getElementById(JSON_ID)) {
        runParser();
        jsonObs.disconnect();
      }
    });
    jsonObs.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    setTimeout(() => jsonObs.disconnect(), 30000);
  }

  function scanCycle() {
    resetForNavigation();
    if (!place()) startScorecardObserver();
    if (document.getElementById(JSON_ID)) {
      runParser();
    } else {
      startJsonObserver();
    }
  }

  // Patch history.pushState / replaceState so the same code
  // path runs for SPA navigations. The MARK symbol guards
  // against re-wrapping if the script runs twice (or another
  // extension wraps the same methods first), which would
  // double-fire scanCycle on every navigation.
  (function patchHistory() {
    const MARK = Symbol.for("rottenKetchup.patched");
    const wrap = (orig) => {
      if (orig?.[MARK]) return orig;
      const patched = function patched(...args) {
        const result = orig.apply(this, args);
        // Defer until after the URL has actually changed and
        // the new DOM is in flight.
        setTimeout(scanCycle, 0);
        return result;
      };
      try {
        Object.defineProperty(patched, MARK, { value: true });
      } catch (e) {
        debug("could not mark patched history fn", e);
      }
      return patched;
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", scanCycle);
    window.addEventListener("hashchange", scanCycle);
  })();

  // Initial scan.
  scanCycle();
})();
