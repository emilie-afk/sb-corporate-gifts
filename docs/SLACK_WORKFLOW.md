# Marketplace Resources and the Slack workflow

**Marketplace Resources** keeps each sales partner's catalogs, price sheets, gift options and terms, assets, and decisions in one place. Partners are the records in Marketplaces that sell, or are being pursued to sell, the company's corporate gifts. Replacing a resource keeps the earlier version in the partner's history. Every change is audited.

Each resource keeps the link to the document itself apart from the message that mentioned it. A resource can wait for its link ("Link needed"). General corporate materials live under **General materials** and can be attached to eligible partners with **Use for other marketplaces**, which adds the same link once per partner and leaves the document's own sharing settings unchanged.

A scheduled scanner reads the team's Slack conversations about corporate gifting and turns them into suggested changes for those partners: status updates, new resources and links, tasks, and explicit confirmations that a task is done. A signed-in team member previews a scan, which lists the exact changes, and then imports it. Discussions about product suppliers or companies outside Marketplaces are skipped. Conflicting information about a partner goes to a review queue instead of changing records. Importing the same scan twice changes nothing.

Tasks are routed by owner. Marketing tasks go to the Marketing Dashboard for review and assignment, then appear in Marketing Tasks. Work owned outside Marketing is a check-off item shown in both apps, and a task without a clear owner waits for a routing decision. **Resolve** (handled without a Task Tracker task) is one shared status on the same record in either app; a task already in Task Tracker is completed there with **Mark done** (see [SHARED_RESOLVED.md](SHARED_RESOLVED.md)). Completed items appear once in the dashboard's weekly report. The dashboard otherwise receives summary counts only. It never receives files, terms, contacts or messages.

Field definitions, endpoints and channel settings are kept in the team's private operator guide.
