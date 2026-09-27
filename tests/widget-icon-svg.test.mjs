import assert from 'node:assert/strict';
import test from 'node:test';
import { WIDGET_ICON_COMPONENTS } from '../lib/widgets/icon-components.js';
import { widgetIconSvgMarkup } from '../lib/widgets/icon-svg.js';

test('every selectable launcher icon can be serialized by the public bootstrap API', () => {
  for (const name of Object.keys(WIDGET_ICON_COMPONENTS)) {
    const svg = widgetIconSvgMarkup(name);
    assert.match(svg, /^<svg\b/, name);
    assert.match(svg, /<(path|circle|rect|line|polyline|polygon|ellipse)\b/, name);
    assert.doesNotMatch(svg, /undefined|<script| key=/, name);
  }
  assert.equal(widgetIconSvgMarkup('unknown-icon'), widgetIconSvgMarkup('message-circle'));
});
