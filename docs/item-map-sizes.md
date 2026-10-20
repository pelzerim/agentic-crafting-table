# Map size profiles

Small/Medium/Large are relative to the item type, not universal dimensions.
Under its Advanced settings disclosure, Settings → Items → [type] configures each supported preset and the default tier.
A bottom-right pixel grip resizes one map alias continuously; there is no Size
context menu. Content follows the largest configured preset that fits, or the
smallest supported presentation. Hover never changes the footprint or content.
Expanded view sizing is independent. Dimensions below are defaults in world pixels.

| Type | Small | Medium | Large | Default |
| --- | --- | --- | --- | --- |
| Claude | 180×48: icon, title, working/attention indicators | 220×84: adds one activity-summary line | 240×112: provider/type and two summary lines | Large |
| Codex | 180×48: icon, title, working/attention indicators | 220×84: adds one activity-summary line | 240×112: provider/type and two summary lines | Large |
| Terminal | 180×48: icon, title, activity indicators | 220×84: one activity-summary line | 240×112: activity summary plus working directory | Large |
| GitHub pull request | 200×48: title and attention | 200×84: adds current PR status | 280×132: longer status plus repository and PR number | Medium |
| Rollout | 200×60: workflow title and status icon | 200×84: status badge and job progress | 280×132: longer progress, repository and branch filter | Medium |
| Note | 160 wide paper: text, 3–14 lines tall | 220 wide paper | 300 wide paper | Small |
| Linear ticket | 240×64: identifier/title and workflow status (48-pixel compatibility floor) | 260×84: adds workflow status | —; open the ticket for details | Small |
| Notion page | 150×48: title and attention | 230×84: adds saved page/sync status | —; open the page for its content | Small |
| Slack | 210×48: message/thread title and attention | 260×104: adds saved scope/message-count status and workspace | —; open the message/thread for its content | Small |
| Code review | 150×48: review title, progress/attention | 240×112: saved result/progress summary, provider and model | —; findings belong in the review | Small |
| Workflow review | 150×48: title, progress/attention | 240×112: saved workflow state plus repository | —; logs/results belong in the review | Small |
| Claude artifact | 150×48: title, progress/attention | 240×96: saved generation status/summary | —; diagram belongs in the artifact | Small |
| Web link | 200×48: title and site icon | 240×96: adds URL | —; open the browser for content | Small |
| Bookmark (legacy/plugin type) | 150×48: title | 240×112: URL and saved bookmark notes | — | Small |
| To-do | 220×48: checkbox and editable text; done keeps its text | — | — | Small only |
| Project | Neighborhood title and status counts | No item Size menu | No item Size menu | Existing representation |

Only already-loaded summaries and declared, non-secret resource fields appear on
the map. A larger size never fetches a provider or fabricates missing metadata.
All sizes retain type color, icon and essential status. Zoom can further simplify
them. To-dos and notes stay inline; a note's height always follows its text.

Existing plugin defaults retain their exact dimensions. Existing saved `mapSize`
values still resolve through these profiles. New `mapDimensions` overrides only
that alias, survives restart and takes precedence over preset dimensions. To-dos
remain single-line (up to 640×72), icon-only badges stay 32–96 per side, and other
types use their declared minimums up to 640×480. Completed items recover their
saved size when reopened. Expanded views and project titles have no map grip.
Unsupported old choices (e.g. Large to-do) render at the supported default without deleting data. New unsupported
UI/MCP commands are rejected. Settings changes are validated and saved atomically
with any collision displacement; no session restarts or provider writes occur.
