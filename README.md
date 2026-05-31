# Freshdesk Business Hours Status Automation

Freshdesk Business Hours Status Automation is a Freshdesk app that changes ticket statuses after a configured number of **Freshdesk business hours** instead of regular calendar hours.

It was created to solve a practical Freshdesk limitation: native time-based automations can count weekends, holidays, and non-working hours when calculating delays. This can cause tickets to move status too early, especially for teams that only want automation timers to run during official support hours.

With this app, a support team can configure a rule such as:

> When a ticket status becomes **Pending**, wait **72 business hours**, then change the ticket status to **Open**.

Instead of counting Saturday, Sunday, holidays, or time outside the configured working schedule, the app calculates the due time using Freshdesk Business Hours and schedules the status change for the correct business-time deadline.

---

## Why this app exists

Freshdesk supports time-based ticket automation, but delay timers may behave like calendar-hour timers. That means a 72-hour delay can continue running over weekends or outside your helpdesk's operating hours.

For many support workflows, that is not ideal. A ticket that enters a waiting or pending status on Friday should not necessarily be moved on Monday morning just because weekend hours were counted.

This app bridges that gap by using Freshdesk Business Hours as the source of truth for status-change timers.

---

## What the app does

The app lets an admin configure one business-hours automation rule:

1. Select the ticket status that should start the timer.
2. Enter the number of business hours to wait.
3. Select the target status to apply after the timer expires.
4. Enable the automation.
5. Save the rule.

After the rule is saved, the app automatically scans existing tickets that already match the trigger status and schedules them. It also listens for future ticket create and ticket update events, so tickets are scheduled automatically when they enter the configured trigger status.

Before the app changes a ticket status, it checks the ticket again. If the ticket has already moved out of the trigger status, the scheduled update is skipped. This prevents the app from overwriting newer manual changes or other automations.

---

## Key features

- **Business-hours-based status automation**  
  Waits for the configured number of Freshdesk business hours before changing a ticket status.

- **Solves weekend-counting issues**  
  Avoids status changes being triggered too early because weekends, holidays, or non-working hours were counted.

- **Configurable automation rule**  
  Choose the trigger status, delay in business hours, and target status.

- **Existing ticket scan**  
  When the rule is saved, the app scans existing tickets in the trigger status and schedules matching tickets.

- **Automatic event-based scheduling**  
  Listens for ticket create and ticket update events, then schedules tickets when they enter the configured trigger status.

- **Freshdesk Business Hours support**  
  Reads Freshdesk Business Hours and uses the configured working schedule, timezone, and returned holiday/closed dates when calculating due times.

- **Safe status verification**  
  Re-checks ticket status before applying the final update.

- **Ticket sidebar visibility**  
  Shows the current ticket timer, due time, and automation state inside the Freshdesk ticket sidebar.

- **Scheduled ticket list**  
  Displays tickets currently scheduled by the app.

- **Manual cancellation**  
  Allows automation to be removed from the current ticket or from all scheduled tickets.

- **Recurring safety scan**  
  Runs a periodic scan to catch missed events, resync existing schedules, and remove stale jobs.

- **Event catch-up handling**  
  Schedules short follow-up checks when Freshdesk events arrive before the latest ticket status is available through the REST API.

---

## How it works

The app runs on the Freshworks platform using a frontend app and serverless backend functions.

### Frontend

The frontend appears in Freshdesk as:

- A full-page app for configuring the automation rule.
- A ticket sidebar app for viewing and managing the current ticket timer.

Admins can enable or disable automation, select statuses, enter the business-hours delay, save the rule, view scheduled tickets, and remove automation where needed.

### Backend

The serverless backend handles:

- App install and uninstall events.
- Ticket create events.
- Ticket update events.
- Scheduled events for due ticket updates.
- Manual scan and scheduling actions.
- Business Hours lookup.
- Ticket status lookup.
- Ticket status updates.
- Pending job storage and cleanup.

When a ticket matches the configured trigger status, the backend calculates a due time by adding the configured delay using business minutes. It then creates a one-time Freshworks scheduled event. When that scheduled event runs, the backend fetches the ticket, confirms that the ticket is still in the original trigger status, and updates it to the configured target status.

---

## Example use cases

### Reopen tickets after waiting for customer response

A team may want tickets in **Pending** or **Waiting on Customer** to return to **Open** after 72 business hours if the customer has not responded.

Freshdesk's native automation may count weekends, but this app waits for the actual configured business hours before reopening the ticket.

### Keep weekend and holiday delays accurate

If a ticket enters the trigger status late on Friday, the app does not treat Saturday and Sunday as working time unless those days are part of the configured Freshdesk Business Hours schedule.

### Avoid premature workflow movement

The app helps teams avoid tickets being moved forward in the workflow during non-working periods, which can improve operational accuracy and SLA-style handling.

---

## Installation parameters

The app requires the following installation parameters:

| Parameter | Required | Description |
| --- | --- | --- |
| `freshdesk_domain` | Yes | Your Freshdesk domain or subdomain, such as `company.freshdesk.com`. Do not include `https://` or trailing slashes. |
| `freshdesk_api_key` | Yes | A Freshdesk admin API key used to read Business Hours, read ticket fields, search tickets, and update ticket statuses. This value is stored securely. |

---

## Freshdesk API actions used

The app uses Freshdesk API access to:

- Fetch ticket details.
- Update ticket status.
- Fetch Freshdesk Business Hours.
- Fetch a specific Business Hours calendar.
- Fetch ticket fields and status choices.
- Search tickets by status.

The API key should belong to a Freshdesk admin or another user with sufficient permissions for these actions.

---

## Project structure

```text
.
├── app/
│   ├── index.html
│   ├── scripts/
│   │   └── app.js
│   └── styles/
│       ├── styles.css
│       └── images/
│           └── icon.svg
├── config/
│   ├── iparams.json
│   └── requests.json
├── server/
│   └── server.js
├── manifest.json
└── package.json
```

---

## Requirements

This app is configured for:

- Freshworks platform version `3.0`
- Node.js `24.11.0`
- Freshworks FDK `10.1.0`

The required versions are defined in `manifest.json`.

---

## Local development

Install the Freshworks Developer Kit and run the app locally from the project root.

```bash
fdk validate
fdk run
```

Then open the app inside Freshdesk using the local development URL provided by the FDK.

---

## Packaging

To package the app for upload:

```bash
fdk pack
```

This generates a packaged app zip that can be uploaded to Freshdesk/Freshworks depending on your app distribution flow.

---

## Configuration workflow

1. Install the app in Freshdesk.
2. Enter your Freshdesk domain.
3. Enter a Freshdesk admin API key.
4. Open the app.
5. Choose whether automation is enabled or disabled.
6. Select the trigger ticket status.
7. Enter the number of business hours to wait.
8. Select the target ticket status.
9. Click **Save automation rule**.

When the rule is saved, the app scans existing matching tickets and schedules active timers.

---

## Current scope and limitations

The current version focuses on one clear workflow: changing a ticket status after a configured number of business hours.

Current limitations:

- Supports one active automation rule.
- Supports status-based triggers only.
- Uses Freshdesk Business Hours as the calendar source.
- Does not expose multiple rules in the UI.
- Does not send public replies as part of the current UI flow.
- Does not apply priority-based filtering in the current UI flow.
- The scan is capped to avoid excessive processing.
- Scheduled execution depends on Freshworks scheduled events and platform runtime behavior.

---

## Safety behavior

The app is designed to avoid unwanted status changes.

Before updating a ticket, it verifies that:

- Automation is still enabled.
- A pending job exists for the ticket.
- The ticket still has the original trigger status.
- The configured target status still exists in Freshdesk.

If the ticket status has changed, the app marks the job as skipped instead of updating the ticket.

---

## Recommended GitHub About description

A Freshdesk app that changes ticket statuses after a configured number of business hours, solving Freshdesk's limitation of counting weekends and non-working hours in time-based automations.

---

## Repository tagline

Automate Freshdesk ticket status changes using business hours instead of calendar hours.

---

## Author

Developed and maintained by Vishal Prasad.
