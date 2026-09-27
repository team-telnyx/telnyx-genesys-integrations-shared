# Video in the Genesys web widget

The visitor and the assigned Genesys agent share a Telnyx Video Room. An Open
Messaging conversation carries the interaction into a Genesys Cloud queue.
Genesys handles assignment, acceptance and wrap-up; Telnyx carries the media.
The interaction consumes **message utilization**, not native Genesys video
utilization. No Telnyx Contact Center queue or agent session is required.

## Widget Studio

Enable **Video**, select a **Genesys Cloud video queue**, then publish the
widget. Queue options come from the connected Genesys organization. Publishing
creates or updates a dedicated Architect inbound message flow, Open Messaging
integration and Interaction Widget, scoped to that queue and the installation's
access groups. A cloned widget receives separate managed resources.

The visitor UI shares the Contact Center video implementation:

- Camera preview and audio-only start; waiting, assigned, connected and ended states.
- Remote, side-by-side, picture-in-picture and spotlight views.
- Camera and microphone controls, optional visitor screen sharing, and agent screen sharing.
- Enlarged modal, video-specific panel dimensions, floating or docked controls.
- Configurable waiting playlist of uploaded MP4/WebM files and hosted HTTPS media, looping or sequential playback.
- Queue/agent notices and editable visitor copy, with Polish and English translations.
- Preview scenarios for prejoin, waiting, connected and screen sharing.
- Optional recording and composed MP4, with an agent playback action after ending.

### Waiting video uploads

In Widget Studio, open **Video → Waiting playlist → Upload video**. Select an MP4
or WebM file (up to 64 MiB). The upload is added to the playlist if it has fewer
than ten entries. Use the arrows to change playback order, or **Add** to reuse
an uploaded file in another widget. HTTPS links can be mixed with uploaded files.
Save the draft and publish to apply the playlist to visitors; Studio's waiting
preview can play it before publication.

Each Genesys organization has a shared library of up to 200 files. Upload and
library management require the widget administrator role; mutations also require
the application origin. A file referenced by a draft, a published revision or an
active video call cannot be deleted. Remove its references, save and publish
changes, and let active calls finish before deleting it from the library.

Files are public playback assets, reachable by their random-ID URL even before
publication. The playback endpoint supports GET, HEAD and byte ranges for seeking.
The server checks file size and MP4/WebM container signatures. Browser codec
support still applies; MP4 with H.264/AAC or WebM with VP8/VP9/Opus are suitable.

Migration 114 creates the metadata table automatically at startup. Files live in
`WIDGET_ASSET_DIR/video` (default `.widget-assets/video`). The existing EC2 Docker
asset volume and Compose `widget_asset_data` volume preserve uploads during code
deployments. Back up this volume together with PostgreSQL. Deployments with
multiple application instances must mount the same persistent asset directory.
No additional Genesys or Telnyx resource is needed for waiting videos.

Contact Center supervisor ACD controls are not part of this integration.

## Prerequisites

Use the existing encrypted runtime configuration for:

- `TELNYX_API_KEY` with Video Rooms access.
- `TELNYX_PUBLIC_KEY`: the account's Ed25519 webhook verification key.
- `GC_PUBLIC_BASE_URL`: the externally reachable HTTPS application origin.
- Genesys client credentials and the existing Genesys browser OAuth login.
- `GC_OPEN_MESSAGING_SECRET`, at least 32 characters.
- Configured Web Chat Infrastructure and an agent Interaction Widget with access
  groups. Video inherits the existing agent panel's current group visibility.
  Older installations without a shared panel use the manifest's access groups.

## Enabling video on another installation

1. Upgrade the application; startup applies the video session and media-library
   migrations automatically.
2. Complete the normal Genesys/Telnyx installation and Web Chat Infrastructure
   setup. Verify the Video Rooms API key, webhook public key and HTTPS origin.
3. Create or select a Genesys queue, assign agents, and give them access to the
   installation's agent panel. Video uses message capacity on this queue.
4. In Widget Studio, enable Video, select that queue, set the allowed website
   origins and recording preferences, then **Publish**. Saving a draft alone
   does not create remote resources. Publish creates and activates the agent
   panel, Open Messaging integration and Architect flow. Later publishes reuse
   their IDs; each cloned widget gets its own resources.
5. Under the video queue, turn on **Automatically open the video panel** and
   publish to configure Genesys Panel Manager. The toggle reads the actual queue
   state; saving a draft stages the change. Then test visitor and agent media
   permissions on the deployment's real HTTPS domain.

No permanent Telnyx room, SIP trunk, telephone number or AI assistant is needed
for video. A room and participant tokens are created when each visitor starts
a call. Ending the call closes its active room sessions and deletes the room;
enabled recordings follow the account's retention policy. The Genesys queue and
its agent membership are administered separately and are not changed by Publish.

Publish validates the webhook key. The public widget configuration contains no
Genesys resource IDs or Telnyx credentials. The browser receives a short-lived
room join token; refresh tokens are stored as hashes and bound to one session
and customer or agent identity.

Relevant routes:

- `/genesys/video-widget?conversationId={{gcConversationId}}`: agent panel.
- `/api/genesys/video-widget`: authenticated assignment checks and agent actions.
- `/api/widgets/:publicId/sessions`: video bootstrap through existing origin guards.
- `/api/widget-sessions/video/{join,token,leave}` and `/video-state`: visitor session actions.
- `/api/webhooks/telnyx/video`: signed room/recording/composition events.

Migration 113 adds video sessions and refresh-token ownership. Startup runs the
migration through the existing migration runner. Cleanup retries every 30 seconds;
visitor polling maintains a two-minute lease so abandoned rooms are closed.
Genesys can return a prefetched conversation ID before the conversation is
readable. The first minute tolerates this 404 as a waiting state. An immediate
visitor cancellation retries the Genesys disconnect during that window so an
interaction cannot remain queued after the video room has closed.
Completed session metadata is retained for one day. Recording files remain in
Telnyx under that account's retention policy.

## Genesys panel opening

The custom Interaction Widget uses `communicationTypeFilter: open`, queue and
group filters, and camera/microphone/display-capture permissions. It joins media
only after the current agent accepts the conversation. Merely offering a queued
interaction does not authorize a room token.

To open the panel automatically, enable **Automatically open the video panel**
below the queue in Studio and publish. Agents need **Agent UI > Default Panels >
View**. The integration account needs View and Edit for Default Panels.
Genesys has one organization-wide default per media type. This installation uses
one shared **Video Auto Open** integration with an explicit list of enabled
queues. Enabling Support preserves other video queues; disabling Support removes
only Support. Each widget's separate panel remains available for manual opening.
The toggle is a queue-wide setting, shared by all widgets routed to that queue.
Switching the selected queue reads its live state and discards the previous
queue's unpublished toggle change. Publishing without changing the toggle preserves
the effective auto-open queue list. If an older widget's manual panel is also the
default, changing its routing first moves automatic opening to the shared panel;
the newly selected queue stays disabled until explicitly enabled.

When a non-video Open Messaging panel is already the default, Studio explains
that enabling video replaces it organization-wide. Its original selection is
saved and restored when the last video queue is disabled, provided an administrator
has not selected another default in the meantime. Other media defaults are preserved.
Existing video defaults from this installation are adopted without dropping their
queues; disabling their last queue returns to the native Profile panel.

The adapter uses `GET/PUT /api/v2/apps/agentui/panels/settings`, the endpoint used
by Genesys Panel Manager. It is not exposed by the generated Platform SDK.
Permission, availability, schema and verification errors fail publication clearly;
the app does not report the setting as applied without reading it back.
PostgreSQL stores recovery state and serializes changes across publishers.

Open Messaging in enabled queues should be reserved for video. Phone calls can
use the same queues because the panel also filters communication type to `open`.
A regular Open Messaging interaction in an enabled queue also matches. The
`telnyx_ai_channel=video` and `telnyx_video_session_id` participant attributes
identify video interactions, but Panel Manager does not use these attributes to
choose its default panel. The agent API additionally requires a matching stored
video session and an assigned agent before issuing any media token.
Automatic opening changes only when an administrator stages a toggle change and
publishes it. Video routing and manual panel provisioning remain independent.

### Native agent panel size

The Genesys interaction-widget schemas and Client Apps SDK expose no native
Small/Medium/Large/Extra Large setting. Agents select **Size > Large** or
**Extra Large** in Agent Workspace. Studio's video dimensions and enlarged-view
presets control the visitor widget. Native agent panel size is managed in Genesys.

See [Genesys Panel Manager](https://help.genesys.cloud/articles/specify-default-panels-for-agent-interactions/)
and [Interaction Widget setup](https://help.genesys.cloud/articles/set-up-an-interaction-widget-integration/).

Closing the agent panel releases local media; the agent can reopen and join the
same accepted interaction. Ending from either side closes the room and disconnects
customer/agent messaging participants through the normal participant PATCH API.
It leaves agent after-contact work open. Cleanup retries also preserve pending
wrap-up. The conversation-wide emergency disconnect API must not be used: it
force-completes ACW with a system wrap-up code. Completing the interaction in
Genesys also closes video.

Configure wrap-up in the selected Genesys queue: assign its business wrap-up codes
and choose **Mandatory, Discretionary** when agents must select a code without a
time limit. Publishing a widget preserves the queue's business settings.
If an accepted agent loses the assignment, including an agent-to-agent transfer,
the current room closes because Telnyx participant tokens cannot be individually
revoked by this integration. A new video session is required after a transfer.

## Validation on your deployment

Run the test suite with `yarn test`. To include database concurrency, media
library and cleanup tests, point the suite at a disposable PostgreSQL database:

```sh
VIDEO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55439/genesys_video_test yarn test
```

For acceptance testing, use a controlled queue and test participants. Verify
visitor camera preview, queue assignment, the agent panel, two-way media, screen
sharing, waiting-video playback and wrap-up after ending the call. Check that
cancelling before assignment removes the queued interaction and closes the room.
If recording is enabled, verify the completed tracks and composition playback
in the connected Telnyx account before relying on recording in production.
