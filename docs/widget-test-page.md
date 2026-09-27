# Widget Studio Test Page

Select a widget in **Web Chat & Voice > Widget Studio**, then open **Delivery >
Test Page**. The selected widget runs through the public loader on a built-in
customer page. No external website or copied embed snippet is needed.

- The widget must be enabled and published. The test uses its published revision;
  publish draft changes before testing them.
- **Reload widget** starts a new page load with the current context. Finish an
  active call before reloading or switching widgets.
- **Open in a new tab** opens the same test page at full browser size.
- **Light**, **Dark** and **System** switch the test site's color theme. The
  choice is remembered in the browser, and the controls wrap within the header
  on narrow screens.
- **Context (JSON, optional)** supplies flat text, numeric, boolean or null values
  to `window.TelnyxWidgetContext`, just like the customer site's integration.
  The last context is remembered in this browser.
- Targeting and decision rules still apply. A hidden widget has a distinct status
  explaining whether targeting or a decision rule hid it.
- Conversations and calls are real and use the selected deployment's services.

An authenticated Genesys widget administrator receives a signed grant for one
widget, published revision and page origin. The grant expires after 12 hours or
becomes invalid when another revision is published. Reload from Test Page to
obtain a fresh grant. This does not modify the widget's allowed origins.
Sessions started with this grant store a `gix-test:` origin. Opening a test is
recorded as `widget.test.opened` in the administration audit log.

The host page is `/genesys/widget-test?widget=<internal-widget-id>`. Opening a
shared link requires the recipient's own Genesys administrator session. The grant
is kept in the loader's page memory, not in that link or local storage.
