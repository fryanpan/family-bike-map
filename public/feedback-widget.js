/**
 * Feedback Widget — embeddable, self-contained IIFE.
 *
 * Usage:
 *   <script src="feedback-widget.js"></script>
 *   <script>
 *     FeedbackWidget.init({
 *       mode: 'mockup',          // 'mockup' | 'live'
 *       endpoint: 'http://localhost:3456/feedback',
 *       authToken: null,         // live mode only
 *       patientSlug: null,       // live mode only
 *     });
 *   </script>
 */
;(function () {
  'use strict';

  // Prevent double-init
  if (window.FeedbackWidget) return;

  // ─── CSS (injected into <head>) ────────────────────────────────────

  const CSS = `
/* ── Feedback Widget ── */

/* Annotation Overlay */
.fw-annotation-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 9998;
  cursor: crosshair;
  pointer-events: none;
}
.fw-annotation-overlay.fw-active {
  display: block;
  pointer-events: auto;
}
.fw-annotation-overlay.fw-draw-mode {
  cursor: crosshair;
}

/* Highlight */
.fw-feedback-highlight {
  position: fixed;
  border: 2px solid #f59e0b;
  background: rgba(245, 158, 11, 0.08);
  border-radius: 4px;
  pointer-events: none;
  z-index: 9999;
  transition: all 0.1s ease;
  display: none;
}

/* Drawing canvas */
.fw-drawing-canvas {
  position: fixed;
  inset: 0;
  z-index: 9997;
  pointer-events: none;
  display: none;
}
.fw-drawing-canvas.fw-active {
  display: block;
  pointer-events: auto;
}

/* Pins */
.fw-annotation-pin {
  position: fixed;
  width: 28px;
  height: 28px;
  background: #f59e0b;
  border: 2px solid #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #000;
  z-index: 10001;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  transform: translate(-50%, -50%);
  animation: fw-pin-pop 0.2s ease-out;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
@keyframes fw-pin-pop {
  0%   { transform: translate(-50%, -50%) scale(0); }
  70%  { transform: translate(-50%, -50%) scale(1.2); }
  100% { transform: translate(-50%, -50%) scale(1); }
}

/* Comment bubbles */
.fw-annotation-comment {
  position: fixed;
  z-index: 10002;
  background: #1a1d27;
  border: 1px solid #f59e0b;
  border-radius: 10px;
  padding: 8px 10px;
  width: 220px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  animation: fw-bubble-in 0.15s ease-out;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
@keyframes fw-bubble-in {
  0%   { opacity: 0; transform: translateY(4px); }
  100% { opacity: 1; transform: translateY(0); }
}
.fw-annotation-comment textarea {
  width: 100%;
  background: #0f1117;
  border: 1px solid #2a2d37;
  border-radius: 6px;
  color: #e1e4ea;
  font-size: 13px;
  padding: 6px 8px;
  resize: none;
  font-family: inherit;
  box-sizing: border-box;
}
.fw-annotation-comment .fw-comment-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}
.fw-annotation-comment .fw-comment-actions button {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  border: none;
  font-family: inherit;
}
.fw-comment-save { background: #f59e0b; color: #000; font-weight: 600; }
.fw-comment-delete { background: #2a2d37; color: #8b8fa3; }

/* FAB */
.fw-feedback-fab {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: linear-gradient(135deg, #2563eb, #7c3aed);
  border: none;
  color: #fff;
  font-size: 22px;
  cursor: pointer;
  z-index: 10010;
  box-shadow: 0 4px 20px rgba(37, 99, 235, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s, box-shadow 0.2s;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1;
  padding: 0;
}

.fw-feedback-fab:hover {
  transform: scale(1.08);
  box-shadow: 0 6px 28px rgba(37, 99, 235, 0.5);
}
.fw-feedback-fab.fw-has-annotations {
  background: linear-gradient(135deg, #f59e0b, #ef4444);
  box-shadow: 0 4px 20px rgba(245, 158, 11, 0.4);
}

/* On mobile, inline in top bar: small blue pill */
@media (max-width: 768px) {
  .fw-feedback-fab {
    position: relative;
    bottom: auto;
    right: auto;
    width: 30px;
    height: 30px;
    font-size: 14px;
    box-shadow: 0 1px 6px rgba(37, 99, 235, 0.3);
  }
  .fw-feedback-fab:hover {
    transform: none;
    box-shadow: 0 1px 6px rgba(37, 99, 235, 0.3);
  }
  .fw-feedback-fab.fw-has-annotations {
    box-shadow: 0 1px 6px rgba(245, 158, 11, 0.3);
  }
}

/* Badge */
.fw-feedback-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 20px;
  height: 20px;
  background: #ef4444;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  display: none;
  align-items: center;
  justify-content: center;
  border: 2px solid #0f1117;
  color: #fff;
  line-height: 1;
}

@media (max-width: 768px) {
  .fw-feedback-badge {
    top: -2px;
    right: -2px;
    width: 15px;
    height: 15px;
    font-size: 9px;
    border: 1.5px solid var(--bg-body, #FAF8F5);
  }
}

/* Panel */
.fw-feedback-panel {
  position: fixed;
  bottom: 88px;
  right: 24px;
  width: 340px;
  max-height: 80vh;
  background: #1a1d27;
  border: 1px solid #2a2d37;
  border-radius: 16px;
  z-index: 10010;
  box-shadow: 0 8px 40px rgba(0,0,0,0.5);
  display: none;
  flex-direction: column;
  overflow: hidden;
  animation: fw-panel-slide 0.2s ease-out;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #e1e4ea;
}

/* On mobile, panel drops below the top bar */
@media (max-width: 768px) {
  .fw-feedback-panel {
    top: calc(var(--header-height, 48px) + env(safe-area-inset-top, 0px) + 8px);
    bottom: auto;
    right: 8px;
    width: calc(100% - 16px);
    max-width: 340px;
    max-height: calc(100vh - var(--header-height, 48px) - var(--nav-height, 56px) - 24px);
  }
}
@keyframes fw-panel-slide {
  0%   { opacity: 0; transform: translateY(12px); }
  100% { opacity: 1; transform: translateY(0); }
}
.fw-feedback-panel.fw-open { display: flex; }

/* Panel header */
.fw-panel-header {
  padding: 14px 16px;
  border-bottom: 1px solid #2a2d37;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.fw-panel-header h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  color: #e1e4ea;
}
.fw-panel-close {
  background: none;
  border: none;
  color: #8b8fa3;
  font-size: 18px;
  cursor: pointer;
  padding: 4px;
  line-height: 1;
}

/* Panel body */
.fw-panel-body {
  padding: 16px;
  overflow-y: auto;
  flex: 1;
}
.fw-panel-body * { box-sizing: border-box; }

/* Sections */
.fw-panel-section {
  margin-bottom: 16px;
}
.fw-panel-section-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #8b8fa3;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

/* Name input */
.fw-name-input {
  width: 100%;
  padding: 10px 12px;
  background: #0f1117;
  border: 1px solid #2a2d37;
  border-radius: 8px;
  color: #e1e4ea;
  font-size: 14px;
  font-family: inherit;
  box-sizing: border-box;
}
.fw-name-input:focus {
  outline: none;
  border-color: #2563eb;
}

/* Add comment button */
.fw-add-comment-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #0f1117;
  border: 1px solid #2a2d37;
  border-radius: 8px;
  color: #c4c8d4;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  width: 100%;
  font-family: inherit;
}
.fw-add-comment-btn:hover { border-color: #f59e0b; color: #f59e0b; }
.fw-add-comment-btn.fw-active {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.08);
  color: #f59e0b;
}
.fw-add-comment-btn .fw-btn-icon { font-size: 16px; }

/* Draw area button */
.fw-draw-area-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #0f1117;
  border: 1px solid #2a2d37;
  border-radius: 8px;
  color: #c4c8d4;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  width: 100%;
  font-family: inherit;
}
.fw-draw-area-btn:hover { border-color: #7c3aed; color: #7c3aed; }
.fw-draw-area-btn.fw-active {
  border-color: #7c3aed;
  background: rgba(124, 58, 237, 0.08);
  color: #7c3aed;
}
.fw-draw-area-btn .fw-btn-icon { font-size: 16px; }

/* Comment row */
.fw-comment-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.fw-comment-row .fw-add-comment-btn { flex: 1; }
.fw-add-more-btn {
  padding: 10px 14px;
  background: transparent;
  border: 1px solid #2a2d37;
  border-radius: 8px;
  color: #f59e0b;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
  display: none;
  font-family: inherit;
}
.fw-add-more-btn:hover { border-color: #f59e0b; background: rgba(245, 158, 11, 0.08); }

/* Textarea */
.fw-feedback-textarea {
  width: 100%;
  min-height: 70px;
  padding: 10px 12px;
  background: #0f1117;
  border: 1px solid #2a2d37;
  border-radius: 8px;
  color: #e1e4ea;
  font-size: 14px;
  resize: vertical;
  font-family: inherit;
  box-sizing: border-box;
}
.fw-feedback-textarea:focus {
  outline: none;
  border-color: #2563eb;
}

/* (Consent checkbox removed - screenshots feature removed) */

/* Button row */
.fw-btn-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.fw-submit-btn {
  flex: 1;
  padding: 12px;
  background: linear-gradient(135deg, #2563eb, #7c3aed);
  border: none;
  border-radius: 10px;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
  font-family: inherit;
}
.fw-submit-btn:hover { opacity: 0.9; }
.fw-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.fw-clear-btn {
  padding: 12px 14px;
  background: none;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  color: #6b7280;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  font-family: inherit;
  white-space: nowrap;
}
.fw-clear-btn:hover { background: #f3f4f6; color: #374151; }

/* Toast */
.fw-toast {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%) translateY(-80px);
  padding: 12px 20px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  z-index: 10020;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  transition: transform 0.3s ease;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.fw-toast.fw-show { transform: translateX(-50%) translateY(0); }
.fw-toast.fw-success { background: #065f46; color: #a7f3d0; }
.fw-toast.fw-error   { background: #7f1d1d; color: #fca5a5; }

/* Mode indicator */
.fw-mode-indicator {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: #f59e0b;
  padding: 6px 16px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  z-index: 10003;
  display: none;
  animation: fw-mode-in 0.2s ease;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
@keyframes fw-mode-in {
  0%   { opacity: 0; transform: translateX(-50%) translateY(-8px); }
  100% { opacity: 1; transform: translateX(-50%) translateY(0); }
}
.fw-mode-indicator.fw-visible { display: flex; align-items: center; gap: 6px; }

/* Done button (inside mode indicator) */
.fw-done-btn {
  margin-left: 8px;
  padding: 4px 14px;
  background: #f59e0b;
  color: #000;
  border: none;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
  font-family: inherit;
}
.fw-done-btn:hover { opacity: 0.85; }

/* Spinner */
@keyframes fw-spin { to { transform: rotate(360deg); } }
.fw-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: fw-spin 0.6s linear infinite;
  vertical-align: middle;
  margin-right: 8px;
}
`;

  // ─── Helpers ───────────────────────────────────────────────────────

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'className') node.className = attrs[k];
        else if (k === 'textContent') node.textContent = attrs[k];
        else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else if (c) node.appendChild(c);
      });
    }
    return node;
  }

  // ─── Element Identification (Multi-Attribute Fingerprint) ─────

  function getVisibleText(elem) {
    // Collect only direct text-node children (no deep clone / traversal)
    var text = '';
    var childNodes = elem.childNodes;
    for (var i = 0; i < childNodes.length; i++) {
      var node = childNodes[i];
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    return text.trim();
  }

  function getIndexPath(elem, maxDepth) {
    var path = [];
    var current = elem;

    for (var i = 0; i < maxDepth && current && current !== document.body; i++) {
      var parent = current.parentElement;
      if (!parent) break;

      var index = Array.prototype.indexOf.call(parent.children, current);
      path.unshift(index);
      current = parent;
    }

    return path;
  }

  function getElementFingerprint(elem) {
    var rect = elem.getBoundingClientRect();
    var viewport = { w: window.innerWidth, h: window.innerHeight };

    // Get more specific attributes for better matching
    var classList = Array.from(elem.classList || []).slice(0, 3); // Top 3 classes
    var dataAttrs = {};
    if (elem.dataset) {
      Object.keys(elem.dataset).slice(0, 3).forEach(function(k) {
        dataAttrs[k] = elem.dataset[k];
      });
    }

    return {
      // Structural path (index-based, 5 levels max)
      path: getIndexPath(elem, 5),

      // Visual position (normalized 0-1, 2 decimals)
      pos: {
        x: +(rect.left / viewport.w).toFixed(2),
        y: +(rect.top / viewport.h).toFixed(2)
      },

      // Text anchor (first 30 chars of visible text)
      txt: getVisibleText(elem).slice(0, 30) || null,

      // Tag name
      tag: elem.tagName.toLowerCase(),

      // Stable attributes (if present)
      attr: {
        id: elem.id || null,
        role: elem.getAttribute('role') || null,
        name: elem.name || null,
        type: elem.type || null,
        classes: classList.length > 0 ? classList : null,
        'aria-label': elem.getAttribute('aria-label') || null
      },

      // Data attributes (for custom identifiers)
      data: Object.keys(dataAttrs).length > 0 ? dataAttrs : null
    };
  }

  function findElementByFingerprint(fp) {
    var candidates = document.querySelectorAll(fp.tag);
    var bestMatch = null;
    var bestScore = 0;
    var viewport = { w: window.innerWidth, h: window.innerHeight };

    for (var i = 0; i < candidates.length; i++) {
      var elem = candidates[i];
      var score = 0;
      var rect = elem.getBoundingClientRect();

      // Position similarity (0-25 points)
      var posX = +(rect.left / viewport.w).toFixed(2);
      var posY = +(rect.top / viewport.h).toFixed(2);
      var posDiff = Math.abs(posX - fp.pos.x) + Math.abs(posY - fp.pos.y);
      score += Math.max(0, 25 - posDiff * 100);

      // Text match (0-25 points)
      if (fp.txt) {
        var elemTxt = getVisibleText(elem).slice(0, 30);
        if (elemTxt === fp.txt) score += 25;
        else if (elemTxt && elemTxt.length > 0 && (elemTxt.indexOf(fp.txt) !== -1 || fp.txt.indexOf(elemTxt) !== -1)) score += 12;
      }

      // Path similarity (0-20 points)
      var elemPath = getIndexPath(elem, 5);
      var pathScore = 0;
      for (var j = 0; j < elemPath.length && j < fp.path.length; j++) {
        if (elemPath[j] === fp.path[j]) pathScore++;
      }
      score += pathScore * 4;

      // Stable attributes (0-30 points, cumulative with cap)
      var attrScore = 0;
      if (fp.attr.id && elem.id === fp.attr.id) attrScore += 30; // ID is strongest signal
      if (fp.attr.role && elem.getAttribute('role') === fp.attr.role) attrScore += 10;
      if (fp.attr.name && elem.name === fp.attr.name) attrScore += 10;
      if (fp.attr.type && elem.getAttribute('type') === fp.attr.type) attrScore += 8;
      if (fp.attr['aria-label'] && elem.getAttribute('aria-label') === fp.attr['aria-label']) attrScore += 12;

      // Class matching (partial credit for shared classes)
      if (fp.attr.classes && fp.attr.classes.length > 0) {
        var elemClasses = Array.from(elem.classList || []);
        var sharedClasses = fp.attr.classes.filter(function(c) { return elemClasses.indexOf(c) !== -1; });
        attrScore += sharedClasses.length * 3;
      }

      // Data attribute matching
      if (fp.data && elem.dataset) {
        var dataMatches = 0;
        Object.keys(fp.data).forEach(function(k) {
          if (elem.dataset[k] === fp.data[k]) dataMatches++;
        });
        attrScore += dataMatches * 8;
      }

      score += Math.min(attrScore, 30);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = elem;
      }
    }

    // Confidence threshold - return null if no good match
    return bestScore >= 40 ? bestMatch : null;
  }

  // ─── Widget Constructor ────────────────────────────────────────────

  function FeedbackWidgetInstance(config) {
    this.config = Object.assign({
      mode: 'mockup',
      endpoint: '',
      authToken: null,
      patientSlug: null,
    }, config);

    this.state = {
      panelOpen: false,
      annotating: false,
      drawingMode: false,
      annotations: [],
    };

    this._lastHovered = null;
    this._boundHandlers = {};
    this._drawingPath = null;
    this._drawingStartPoint = null;

    this._injectCSS();
    this._buildDOM();
    this._bindEvents();
    this._restoreState();
  }

  // ─── CSS injection ─────────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._injectCSS = function () {
    if (document.getElementById('fw-styles')) return;
    var style = document.createElement('style');
    style.id = 'fw-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  };

  // ─── DOM construction ──────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._buildDOM = function () {
    // Annotation overlay
    this.overlay = el('div', { className: 'fw-annotation-overlay' });
    document.body.appendChild(this.overlay);

    // Drawing canvas
    this.drawingCanvas = document.createElement('canvas');
    this.drawingCanvas.className = 'fw-drawing-canvas';
    this.drawingCtx = this.drawingCanvas.getContext('2d');
    document.body.appendChild(this.drawingCanvas);

    // Highlight
    this.highlight = el('div', { className: 'fw-feedback-highlight' });
    document.body.appendChild(this.highlight);

    // Mode indicator
    this.doneBtn = el('button', { className: 'fw-done-btn', textContent: 'Review & submit \u203a' });
    this.modeIndicator = el('div', { className: 'fw-mode-indicator' }, [
      el('span', { textContent: '\uD83D\uDCAC' }),
      el('span', { textContent: 'Click elements to comment' }),
      this.doneBtn,
    ]);
    document.body.appendChild(this.modeIndicator);

    // Toast
    this.toast = el('div', { className: 'fw-toast' });
    document.body.appendChild(this.toast);

    // FAB
    this.badge = el('span', { className: 'fw-feedback-badge', textContent: '0' });
    this.fab = el('button', {
      className: 'fw-feedback-fab',
      title: 'Give feedback',
    }, [
      document.createTextNode('\uD83D\uDCAC'),
      this.badge,
    ]);

    // On mobile, place FAB in the top bar between brand and patient selector.
    // On desktop, float as fixed button on body.
    var self = this;
    function placeFab(isMobile) {
      var topBarRightEl = document.querySelector('.top-bar-right');
      if (isMobile && topBarRightEl) {
        if (self.fab.parentNode !== topBarRightEl) {
          topBarRightEl.insertBefore(self.fab, topBarRightEl.firstElementChild);
        }
      } else {
        if (self.fab.parentNode !== document.body) {
          document.body.appendChild(self.fab);
        }
      }
    }

    if (typeof window.matchMedia === 'function') {
      var mq = window.matchMedia('(max-width: 768px)');
      placeFab(mq.matches);
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', function (e) { placeFab(e.matches); });
      } else if (typeof mq.addListener === 'function') {
        mq.addListener(function (e) { placeFab(e.matches); });
      }
    } else {
      placeFab(window.innerWidth <= 768);
      window.addEventListener('resize', function () { placeFab(window.innerWidth <= 768); });
    }

    // Panel
    this.panelClose = el('button', { className: 'fw-panel-close', textContent: '\u2715' });
    var header = el('div', { className: 'fw-panel-header' }, [
      el('h2', { textContent: 'Feedback' }),
      this.panelClose,
    ]);

    // Name section
    this.nameInput = el('input', {
      className: 'fw-name-input',
      type: 'text',
      placeholder: 'Enter your name (optional)',
    });
    var nameSection = el('div', { className: 'fw-panel-section' }, [
      el('span', { className: 'fw-panel-section-label', textContent: 'Your Name' }),
      this.nameInput,
    ]);

    // Comment section
    this.addCommentLabel = el('span', { textContent: 'Add comment on page' });
    this.addCommentBtn = el('button', { className: 'fw-add-comment-btn' }, [
      el('span', { className: 'fw-btn-icon', textContent: '\uD83D\uDCAC' }),
      this.addCommentLabel,
    ]);
    this.drawAreaLabel = el('span', { textContent: 'Draw area' });
    this.drawAreaBtn = el('button', { className: 'fw-draw-area-btn' }, [
      el('span', { className: 'fw-btn-icon', textContent: '✏️' }),
      this.drawAreaLabel,
    ]);
    this.addMoreBtn = el('button', { className: 'fw-add-more-btn', textContent: '+ Add more' });
    this.commentRow = el('div', { className: 'fw-comment-row' }, [
      this.addCommentBtn,
      this.addMoreBtn,
    ]);
    var commentSection = el('div', { className: 'fw-panel-section' }, [
      el('span', { className: 'fw-panel-section-label', textContent: 'Give Feedback' }),
      this.commentRow,
      this.drawAreaBtn,
    ]);

    // Text section
    this.feedbackText = el('textarea', {
      className: 'fw-feedback-textarea',
      placeholder: 'Describe what you\'d like to change...',
    });
    var textSection = el('div', { className: 'fw-panel-section' }, [
      this.feedbackText,
    ]);

    // (Screenshot functionality removed per user request)

    // Submit + Clear
    this.submitBtn = el('button', { className: 'fw-submit-btn', textContent: 'Submit Feedback' });
    this.clearBtn = el('button', { className: 'fw-clear-btn', textContent: 'Clear all' });
    var btnRow = el('div', { className: 'fw-btn-row' }, [this.clearBtn, this.submitBtn]);

    // Panel body
    var panelBody = el('div', { className: 'fw-panel-body' }, [
      nameSection,
      commentSection,
      textSection,
      btnRow,
    ]);

    this.panel = el('div', { className: 'fw-feedback-panel' }, [header, panelBody]);
    document.body.appendChild(this.panel);
  };

  // ─── Event binding ─────────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._bindEvents = function () {
    var self = this;

    // FAB toggle
    this.fab.addEventListener('click', function () {
      self.state.panelOpen = !self.state.panelOpen;
      self.panel.classList.toggle('fw-open', self.state.panelOpen);
      if (!self.state.panelOpen && self.state.annotating) self._toggleAnnotation();
    });

    // Panel close
    this.panelClose.addEventListener('click', function () {
      self.state.panelOpen = false;
      self.panel.classList.remove('fw-open');
      if (self.state.annotating) self._toggleAnnotation();
    });

    // Add comment / add more
    this.addCommentBtn.addEventListener('click', function () { self._toggleAnnotation(); });
    this.addMoreBtn.addEventListener('click', function () { self._toggleAnnotation(); });

    // Draw area
    this.drawAreaBtn.addEventListener('click', function () { self._toggleDrawing(); });

    // Done annotating (CRITICAL: stopPropagation)
    this.doneBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (self.state.annotating) self._toggleAnnotation();
    });

    // Hover highlight
    this.overlay.addEventListener('mousemove', function (e) { self._onOverlayMouseMove(e); });
    this.overlay.addEventListener('mouseleave', function () {
      self.highlight.style.display = 'none';
      self._lastHovered = null;
    });

    // Click to annotate
    this.overlay.addEventListener('click', function (e) { self._onOverlayClick(e); });

    // Drawing handlers
    this._boundHandlers.canvasMouseDown = function (e) { self._onCanvasMouseDown(e); };
    this._boundHandlers.canvasMouseMove = function (e) { self._onCanvasMouseMove(e); };
    this._boundHandlers.canvasMouseUp = function (e) { self._onCanvasMouseUp(e); };

    this.drawingCanvas.addEventListener('mousedown', this._boundHandlers.canvasMouseDown);
    this.drawingCanvas.addEventListener('mousemove', this._boundHandlers.canvasMouseMove);
    this.drawingCanvas.addEventListener('mouseup', this._boundHandlers.canvasMouseUp);

    // Submit
    this.submitBtn.addEventListener('click', function () { self._submit(); });

    // Clear all
    this.clearBtn.addEventListener('click', function () { self._clearAll(); });

    // Click outside to close panel
    this._boundHandlers.docClick = function (e) {
      if (self.state.annotating) return;
      if (self.state.panelOpen && !self.panel.contains(e.target) && !self.fab.contains(e.target)) {
        self.state.panelOpen = false;
        self.panel.classList.remove('fw-open');
      }
    };
    document.addEventListener('click', this._boundHandlers.docClick);

    // Save state before live reload or navigation
    this._boundHandlers.beforeUnload = function () {
      self._saveState();
    };
    window.addEventListener('beforeunload', this._boundHandlers.beforeUnload);

    // Pin click -> show/edit comment
    this._boundHandlers.pinClick = function (e) {
      var pin = e.target.closest('.fw-annotation-pin');
      if (!pin) return;
      var id = parseInt(pin.textContent, 10);
      var ann = self.state.annotations.find(function (a) { return a.id === id; });
      if (!ann || ann.commentEl) return;
      self._showCommentBubble(ann);
    };
    document.addEventListener('click', this._boundHandlers.pinClick);
  };

  // ─── Annotation mode toggle ────────────────────────────────────────

  FeedbackWidgetInstance.prototype._toggleAnnotation = function () {
    // If drawing mode is active, turn it off first
    if (this.state.drawingMode) {
      this._toggleDrawing();
    }

    this.state.annotating = !this.state.annotating;
    this.addCommentBtn.classList.toggle('fw-active', this.state.annotating);
    this.overlay.classList.toggle('fw-active', this.state.annotating);
    this.modeIndicator.classList.toggle('fw-visible', this.state.annotating);
    if (!this.state.annotating) {
      this.highlight.style.display = 'none';
    }
    // Close panel while annotating
    if (this.state.annotating && this.state.panelOpen) {
      this.panel.classList.remove('fw-open');
    } else if (!this.state.annotating) {
      this.panel.classList.add('fw-open');
      this.state.panelOpen = true;
    }
  };

  // ─── Drawing mode toggle ──────────────────────────────────────────

  FeedbackWidgetInstance.prototype._toggleDrawing = function () {
    // If annotation mode is active, turn it off first
    if (this.state.annotating) {
      this._toggleAnnotation();
    }

    this.state.drawingMode = !this.state.drawingMode;
    this.drawAreaBtn.classList.toggle('fw-active', this.state.drawingMode);
    this.drawingCanvas.classList.toggle('fw-active', this.state.drawingMode);

    if (this.state.drawingMode) {
      // Resize canvas to match viewport
      this.drawingCanvas.width = window.innerWidth;
      this.drawingCanvas.height = window.innerHeight;
      this.drawingCanvas.style.width = window.innerWidth + 'px';
      this.drawingCanvas.style.height = window.innerHeight + 'px';

      // Update mode indicator
      this.modeIndicator.querySelector('span:nth-child(2)').textContent = 'Draw areas to annotate';
      this.modeIndicator.classList.add('fw-visible');

      // Close panel while drawing
      if (this.state.panelOpen) {
        this.panel.classList.remove('fw-open');
      }
    } else {
      this.modeIndicator.classList.remove('fw-visible');
      this.modeIndicator.querySelector('span:nth-child(2)').textContent = 'Click elements to comment';

      // Clear canvas
      this.drawingCtx.clearRect(0, 0, this.drawingCanvas.width, this.drawingCanvas.height);
      this._drawingPath = null;
      this._drawingStartPoint = null;

      // Reopen panel
      this.panel.classList.add('fw-open');
      this.state.panelOpen = true;
    }
  };

  // ─── Overlay hover ─────────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._onOverlayMouseMove = function (e) {
    if (!this.state.annotating) return;
    this.overlay.style.pointerEvents = 'none';
    var elem = document.elementFromPoint(e.clientX, e.clientY);
    this.overlay.style.pointerEvents = '';

    if (!elem || elem === document.body || elem === document.documentElement ||
        elem.closest('.fw-feedback-panel') || elem.closest('.fw-feedback-fab') ||
        elem.closest('.fw-annotation-pin') || elem.closest('.fw-annotation-comment')) {
      this.highlight.style.display = 'none';
      this._lastHovered = null;
      return;
    }

    if (elem !== this._lastHovered) {
      this._lastHovered = elem;
      var rect = elem.getBoundingClientRect();
      this.highlight.style.display = 'block';
      this.highlight.style.top = rect.top + 'px';
      this.highlight.style.left = rect.left + 'px';
      this.highlight.style.width = rect.width + 'px';
      this.highlight.style.height = rect.height + 'px';
    }
  };

  // ─── Overlay click (place annotation) ──────────────────────────────

  FeedbackWidgetInstance.prototype._onOverlayClick = function (e) {
    if (!this.state.annotating) return;

    this.overlay.style.pointerEvents = 'none';
    var elem = document.elementFromPoint(e.clientX, e.clientY);
    this.overlay.style.pointerEvents = '';

    if (!elem || elem === document.body || elem === document.documentElement) return;

    var rect = elem.getBoundingClientRect();
    var id = this.state.annotations.length + 1;

    // Create pin at top-right of element
    var pin = el('div', { className: 'fw-annotation-pin', textContent: String(id) });
    pin.style.top = rect.top + 'px';
    pin.style.left = (rect.left + rect.width) + 'px';
    document.body.appendChild(pin);

    var annotation = {
      id: id,
      type: 'element',
      fingerprint: getElementFingerprint(elem),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      comment: '',
      pinEl: pin,
      commentEl: null,
    };
    this.state.annotations.push(annotation);

    // Show comment bubble
    this._showCommentBubble(annotation);

    this._updateBadge();
  };

  // ─── Drawing handlers ──────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._onCanvasMouseDown = function (e) {
    if (!this.state.drawingMode) return;

    this._drawingPath = [{x: e.clientX, y: e.clientY}];
    this._drawingStartPoint = {x: e.clientX, y: e.clientY};
  };

  FeedbackWidgetInstance.prototype._onCanvasMouseMove = function (e) {
    if (!this.state.drawingMode || !this._drawingPath) return;

    this._drawingPath.push({x: e.clientX, y: e.clientY});

    // Redraw canvas
    this.drawingCtx.clearRect(0, 0, this.drawingCanvas.width, this.drawingCanvas.height);
    this.drawingCtx.strokeStyle = '#7c3aed';
    this.drawingCtx.lineWidth = 3;
    this.drawingCtx.lineCap = 'round';
    this.drawingCtx.lineJoin = 'round';

    this.drawingCtx.beginPath();
    this.drawingCtx.moveTo(this._drawingPath[0].x, this._drawingPath[0].y);
    for (var i = 1; i < this._drawingPath.length; i++) {
      this.drawingCtx.lineTo(this._drawingPath[i].x, this._drawingPath[i].y);
    }
    this.drawingCtx.stroke();
  };

  FeedbackWidgetInstance.prototype._onCanvasMouseUp = function (e) {
    if (!this.state.drawingMode || !this._drawingPath || this._drawingPath.length < 3) {
      this._drawingPath = null;
      this._drawingStartPoint = null;
      return;
    }

    // Calculate bounding box of drawn path
    var minX = Math.min.apply(Math, this._drawingPath.map(function(p) { return p.x; }));
    var maxX = Math.max.apply(Math, this._drawingPath.map(function(p) { return p.x; }));
    var minY = Math.min.apply(Math, this._drawingPath.map(function(p) { return p.y; }));
    var maxY = Math.max.apply(Math, this._drawingPath.map(function(p) { return p.y; }));

    var rect = {
      top: minY,
      left: minX,
      width: maxX - minX,
      height: maxY - minY
    };

    // Save the drawn path with normalization for viewport changes
    var viewport = { w: window.innerWidth, h: window.innerHeight };
    var normalizedPath = this._drawingPath.map(function(p) {
      return {
        x: +(p.x / viewport.w).toFixed(4),
        y: +(p.y / viewport.h).toFixed(4)
      };
    });

    var id = this.state.annotations.length + 1;

    // Create pin at center of drawn area
    var pin = el('div', { className: 'fw-annotation-pin', textContent: String(id) });
    pin.style.top = (minY + (maxY - minY) / 2) + 'px';
    pin.style.left = (minX + (maxX - minX) / 2) + 'px';
    document.body.appendChild(pin);

    var annotation = {
      id: id,
      type: 'area',
      path: normalizedPath,
      rect: rect,
      comment: '',
      pinEl: pin,
      commentEl: null,
    };
    this.state.annotations.push(annotation);

    // Clear canvas
    this.drawingCtx.clearRect(0, 0, this.drawingCanvas.width, this.drawingCanvas.height);
    this._drawingPath = null;
    this._drawingStartPoint = null;

    // Show comment bubble
    this._showCommentBubble(annotation);

    this._updateBadge();
  };

  // ─── Comment bubble ────────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._showCommentBubble = function (annotation) {
    var self = this;

    // Auto-save and close any other open bubbles
    this.state.annotations.forEach(function (a) {
      if (a.commentEl && a.id !== annotation.id) {
        var ta = a.commentEl.querySelector('textarea');
        if (ta) a.comment = ta.value;
        a.commentEl.remove();
        a.commentEl = null;
      }
    });

    var rect = annotation.rect;

    var bubble = el('div', { className: 'fw-annotation-comment' });
    bubble.style.top = (rect.top - 4) + 'px';
    bubble.style.left = (rect.left + rect.width + 20) + 'px';
    if (parseInt(bubble.style.left, 10) + 220 > window.innerWidth) {
      bubble.style.left = (rect.left - 230) + 'px';
    }

    var ta = el('textarea', {
      rows: '2',
      placeholder: 'What should change here?',
    });
    ta.value = annotation.comment || '';

    var deleteBtn = el('button', { className: 'fw-comment-delete', textContent: 'Delete' });
    var saveBtn = el('button', { className: 'fw-comment-save', textContent: 'Save' });
    var actions = el('div', { className: 'fw-comment-actions' }, [deleteBtn, saveBtn]);

    bubble.appendChild(ta);
    bubble.appendChild(actions);
    document.body.appendChild(bubble);
    annotation.commentEl = bubble;

    ta.focus();
    if (annotation.comment) {
      ta.selectionStart = ta.value.length;
    }

    saveBtn.addEventListener('click', function () {
      annotation.comment = ta.value;
      bubble.remove();
      annotation.commentEl = null;
      self._updateCommentLabel();
    });

    deleteBtn.addEventListener('click', function () {
      self._removeAnnotation(annotation.id);
    });

    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        annotation.comment = ta.value;
        bubble.remove();
        annotation.commentEl = null;
        self._updateCommentLabel();
      }
    });
  };

  // ─── Remove annotation ─────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._removeAnnotation = function (id) {
    var idx = this.state.annotations.findIndex(function (a) { return a.id === id; });
    if (idx === -1) return;
    var ann = this.state.annotations[idx];
    if (ann.pinEl) ann.pinEl.remove();
    if (ann.commentEl) ann.commentEl.remove();
    this.state.annotations.splice(idx, 1);
    // Re-number remaining annotations
    this.state.annotations.forEach(function (a, i) {
      a.id = i + 1;
      a.pinEl.textContent = a.id;
    });
    this._updateCommentLabel();
    this._updateBadge();
  };

  // ─── UI updates ────────────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._updateCommentLabel = function () {
    var count = this.state.annotations.length;
    this.addCommentLabel.textContent = count === 0
      ? 'Add comment on page'
      : count + ' comment' + (count === 1 ? '' : 's') + ' on page';
    this.addMoreBtn.style.display = count > 0 ? '' : 'none';
  };

  FeedbackWidgetInstance.prototype._updateBadge = function () {
    var count = this.state.annotations.length;
    this.badge.style.display = count > 0 ? 'flex' : 'none';
    this.badge.textContent = count;
    this.fab.classList.toggle('fw-has-annotations', count > 0);
  };

  // ─── Toast ─────────────────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._showToast = function (message, type) {
    var self = this;
    this.toast.textContent = message;
    this.toast.className = 'fw-toast ' + (type === 'error' ? 'fw-error' : 'fw-success');
    // Force reflow so re-adding fw-show re-triggers the transition
    void this.toast.offsetWidth;
    this.toast.classList.add('fw-show');
    setTimeout(function () { self.toast.classList.remove('fw-show'); }, 2500);
  };

  // ─── Screenshot capture (removed per user request) ────────────────

  // ─── Submit ────────────────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._submit = function () {
    var self = this;

    // Auto-save any open comment bubbles before building payload
    this.state.annotations.forEach(function (a) {
      if (a.commentEl) {
        var ta = a.commentEl.querySelector('textarea');
        if (ta) a.comment = ta.value;
        a.commentEl.remove();
        a.commentEl = null;
      }
    });

    this.submitBtn.innerHTML = '<span class="fw-spinner"></span>Sending...';
    this.submitBtn.disabled = true;

    // Build payload (screenshots removed per user request)
    var payload = {
      author: self.nameInput.value || 'Anonymous',
      annotations: self.state.annotations.map(function (a) {
        var baseAnnotation = {
          id: a.id,
          type: a.type,
          rect: a.rect,
          text: a.comment,
        };

        if (a.type === 'element') {
          baseAnnotation.fingerprint = a.fingerprint;
        } else if (a.type === 'area') {
          baseAnnotation.path = a.path;
          baseAnnotation.description = 'Freeform drawn area covering approximately ' +
            Math.round(a.rect.width) + 'x' + Math.round(a.rect.height) + 'px';
        }

        return baseAnnotation;
      }),
      text: self.feedbackText.value,
      pageUrl: window.location.href,
      timestamp: new Date().toISOString(),
    };

    // Build headers
    var headers = { 'Content-Type': 'application/json' };
    if (self.config.mode === 'live' && self.config.authToken) {
      headers['Authorization'] = 'Bearer ' + self.config.authToken;
    }

    fetch(self.config.endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
    }).then(function (resp) {
      if (!resp.ok) throw new Error('Server responded with ' + resp.status);
      return resp.json();
    }).then(function (data) {
      // Show success with Linear ticket info
      var message = '\u2713 Feedback sent!';
      if (data && data.identifier) {
        message += ' Created ticket ' + data.identifier;
      }
      self._showToast(message, 'success');
      self._resetForm();
    }).catch(function (err) {
      console.error('[FeedbackWidget] Submit failed:', err);
      self._showToast('Failed to send feedback. Please try again.', 'error');
      self.submitBtn.innerHTML = 'Submit Feedback';
      self.submitBtn.disabled = false;
    });
  };

  // ─── Reset form ────────────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._resetForm = function () {
    this.submitBtn.innerHTML = 'Submit Feedback';
    this.submitBtn.disabled = false;
    this.feedbackText.value = '';
    this.feedbackText.style.height = '';
    // Remove all annotation DOM elements
    this.state.annotations.forEach(function (a) {
      if (a.pinEl) a.pinEl.remove();
      if (a.commentEl) a.commentEl.remove();
    });
    this.state.annotations = [];
    this._updateCommentLabel();
    this._updateBadge();
    // Close panel
    this.state.panelOpen = false;
    this.panel.classList.remove('fw-open');
  };

  // ─── Clear all ──────────────────────────────────────────────────────

  FeedbackWidgetInstance.prototype._clearAll = function () {
    // Remove all annotation DOM elements
    this.state.annotations.forEach(function (a) {
      if (a.pinEl) a.pinEl.remove();
      if (a.commentEl) a.commentEl.remove();
    });
    this.state.annotations = [];
    this.feedbackText.value = '';
    this.feedbackText.style.height = '';
    this._updateCommentLabel();
    this._updateBadge();
    // Clear persisted state
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
    this._showToast('Cleared all feedback', 'success');
  };

  // ─── Persist state across live reloads ──────────────────────────────

  var STORAGE_KEY = 'fw-pending-state';

  FeedbackWidgetInstance.prototype._saveState = function () {
    // Auto-save any open comment bubbles
    this.state.annotations.forEach(function (a) {
      if (a.commentEl) {
        var ta = a.commentEl.querySelector('textarea');
        if (ta) a.comment = ta.value;
      }
    });

    var data = {
      annotations: this.state.annotations.map(function (a) {
        var baseAnnotation = {
          id: a.id,
          type: a.type,
          rect: a.rect,
          comment: a.comment,
        };

        if (a.type === 'element') {
          baseAnnotation.fingerprint = a.fingerprint;
        } else if (a.type === 'area') {
          baseAnnotation.path = a.path;
        }

        return baseAnnotation;
      }),
      text: this.feedbackText ? this.feedbackText.value : '',
      name: this.nameInput ? this.nameInput.value : '',
      panelOpen: this.state.panelOpen,
    };

    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* quota exceeded — non-critical */ }
  };

  FeedbackWidgetInstance.prototype._restoreState = function () {
    var raw;
    try {
      raw = sessionStorage.getItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) { return; }

    if (!raw) return;

    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    // Restore text fields
    if (data.name && this.nameInput) this.nameInput.value = data.name;
    if (data.text && this.feedbackText) this.feedbackText.value = data.text;

    // Restore annotations
    var self = this;
    if (data.annotations && data.annotations.length > 0) {
      data.annotations.forEach(function (saved) {
        var rect = saved.rect;
        var elem = null;
        var pinTop, pinLeft;

        // For element annotations, try to relocate via fingerprint
        if (saved.type === 'element') {
          try {
            if (saved.fingerprint) {
              elem = findElementByFingerprint(saved.fingerprint);
              if (elem) {
                var r = elem.getBoundingClientRect();
                rect = { top: r.top, left: r.left, width: r.width, height: r.height };
              }
            }
          } catch (e) { /* fingerprint lookup may fail */ }

          pinTop = rect.top;
          pinLeft = rect.left + rect.width;
        }
        // For area annotations, reconstruct from normalized path
        else if (saved.type === 'area' && saved.path) {
          var viewport = { w: window.innerWidth, h: window.innerHeight };
          var minX = Math.min.apply(Math, saved.path.map(function(p) { return p.x * viewport.w; }));
          var maxX = Math.max.apply(Math, saved.path.map(function(p) { return p.x * viewport.w; }));
          var minY = Math.min.apply(Math, saved.path.map(function(p) { return p.y * viewport.h; }));
          var maxY = Math.max.apply(Math, saved.path.map(function(p) { return p.y * viewport.h; }));

          rect = {
            top: minY,
            left: minX,
            width: maxX - minX,
            height: maxY - minY
          };

          pinTop = minY + (maxY - minY) / 2;
          pinLeft = minX + (maxX - minX) / 2;
        } else {
          // Fallback: use saved rect directly, pin at top-right
          pinTop = rect.top;
          pinLeft = rect.left + rect.width;
        }

        // Create pin
        var pin = el('div', { className: 'fw-annotation-pin', textContent: String(saved.id) });
        pin.style.top = pinTop + 'px';
        pin.style.left = pinLeft + 'px';
        document.body.appendChild(pin);

        var restoredAnnotation = {
          id: saved.id,
          type: saved.type || 'element',
          rect: rect,
          comment: saved.comment || '',
          pinEl: pin,
          commentEl: null,
        };

        if (saved.type === 'element') {
          restoredAnnotation.fingerprint = saved.fingerprint;
        } else if (saved.type === 'area') {
          restoredAnnotation.path = saved.path;
        }

        self.state.annotations.push(restoredAnnotation);
      });
      self._updateCommentLabel();
      self._updateBadge();
    }

    // Restore panel open state
    if (data.panelOpen) {
      self.state.panelOpen = true;
      self.panel.classList.add('fw-open');
    }
  };

  // ─── Destroy (clean up) ────────────────────────────────────────────

  FeedbackWidgetInstance.prototype.destroy = function () {
    // Remove DOM elements
    [this.overlay, this.highlight, this.drawingCanvas, this.modeIndicator, this.toast, this.fab, this.panel]
      .forEach(function (node) { if (node && node.parentNode) node.parentNode.removeChild(node); });
    // Remove annotation pins/bubbles
    this.state.annotations.forEach(function (a) {
      if (a.pinEl) a.pinEl.remove();
      if (a.commentEl) a.commentEl.remove();
    });
    // Remove event listeners
    document.removeEventListener('click', this._boundHandlers.docClick);
    document.removeEventListener('click', this._boundHandlers.pinClick);
    window.removeEventListener('beforeunload', this._boundHandlers.beforeUnload);
    this.drawingCanvas.removeEventListener('mousedown', this._boundHandlers.canvasMouseDown);
    this.drawingCanvas.removeEventListener('mousemove', this._boundHandlers.canvasMouseMove);
    this.drawingCanvas.removeEventListener('mouseup', this._boundHandlers.canvasMouseUp);
    // Remove style tag
    var styleEl = document.getElementById('fw-styles');
    if (styleEl) styleEl.remove();
  };

  // ─── Public API ────────────────────────────────────────────────────

  var _instance = null;

  window.FeedbackWidget = {
    /**
     * Initialise the feedback widget.
     * @param {Object} config
     * @param {string} config.mode       - 'mockup' | 'live'
     * @param {string} config.endpoint   - URL to POST feedback payload
     * @param {string} [config.authToken]    - Bearer token (live mode)
     * @param {string} [config.patientSlug]  - Patient slug (live mode)
     * @returns {FeedbackWidgetInstance}
     */
    init: function (config) {
      if (_instance) {
        console.warn('[FeedbackWidget] Already initialised. Call destroy() first to re-init.');
        return _instance;
      }
      _instance = new FeedbackWidgetInstance(config || {});
      return _instance;
    },

    /** Tear down the widget and remove all DOM / listeners. */
    destroy: function () {
      if (_instance) {
        _instance.destroy();
        _instance = null;
      }
    },
  };
})();
