// Business hours automation for Freshdesk.
// Serverless-only version. No sidebar client is required.
// Freshworks serverless runtime expects a global exports object. Do not use module.exports.

const JOB_PREFIX = "bhra:job:";
const JOB_INDEX_KEY = "bhra:job:index";
const JOB_CACHE_KEY = "bhra:job:cache";
const JOB_INDEX_TEXT_KEY = "bhra:job:index:text";
const JOB_CACHE_TEXT_KEY = "bhra:job:cache:text";
const JOB_SNAPSHOT_KEY = "bhra:job:snapshot";
const JOB_SNAPSHOT_TEXT_KEY = "bhra:job:snapshot:text";
const JOB_SNAPSHOT_TOMBSTONE_KEY = "bhra:job:snapshot:tombstones";
const JOB_SNAPSHOT_TOMBSTONE_TEXT_KEY = "bhra:job:snapshot:tombstones:text";
const LOG_PREFIX = "bhra:log:";
const CONFIG_KEY = "bhra:config";
const CONFIG_BACKUP_KEY = "bhra:config:backup";
const CONFIG_TEXT_KEY = "bhra:config:text";
const ENABLED_STATE_KEY = "bhra:enabled_state";
const ENABLED_STATE_BACKUP_KEY = "bhra:enabled_state:backup";
const ENABLED_STATE_TEXT_KEY = "bhra:enabled_state:text";
const CONFIG_MIRROR_KEY = "bhra_config";
const CONFIG_MIRROR_TEXT_KEY = "bhra_config_text";
const ENABLED_STATE_MIRROR_KEY = "bhra_enabled_state";
const ENABLED_STATE_MIRROR_TEXT_KEY = "bhra_enabled_state_text";
const BUSINESS_HOURS_CACHE_KEY = "bhra:cache:business_hours";
const BUSINESS_HOUR_DETAIL_CACHE_PREFIX = "bhra:cache:business_hour:";
const TICKET_FIELDS_CACHE_KEY = "bhra:cache:ticket_fields";
const BUSINESS_HOURS_CACHE_TTL_MS = 30 * 60 * 1000;
const TICKET_FIELDS_CACHE_TTL_MS = 30 * 60 * 1000;
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DEFAULT_REPLY = "";
const CUSTOM_BUSINESS_HOURS_ID = "__custom__";
const DEFAULT_CUSTOM_CALENDAR = {
  name: "Freshdesk business hours (default)",
  timeZone: "UTC",
  workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  start: "09:00",
  end: "17:00",
  holidays: []
};
const ANY_PRIORITY = "Any priority";
const DEFAULT_RULE = {
  id: "rule_1",
  enabled: true,
  name: "Business hours automation",
  priorityOrder: 1,
  triggerStatusName: "",
  priorityName: ANY_PRIORITY,
  delayBusinessHours: "",
  sendPublicReply: false,
  replyBody: DEFAULT_REPLY,
  changeStatus: true,
  targetStatusName: ""
};
const MAX_SCAN_PAGES = 10;
const MAX_SCAN_TICKETS = 300;
const MAX_DISPLAY_JOBS = 300;
const MAX_RECONCILE_JOBS = 300;
const AUTO_SCAN_SCHEDULE_NAME = "ra_auto_status_scan";
const TICKET_EVENT_CATCHUP_PREFIX = "ra_ticket_event_catchup_";
const AUTO_SCAN_INTERVAL_MINUTES = 5;
const TICKET_EVENT_CATCHUP_DELAY_SECONDS = 30;
const AUTO_SCAN_START_BUFFER_SECONDS = 15;
const TZ_MAP = {
  "UTC": "UTC",
  "Eastern Time (US & Canada)": "America/New_York",
  "Central Time (US & Canada)": "America/Chicago",
  "Mountain Time (US & Canada)": "America/Denver",
  "Pacific Time (US & Canada)": "America/Los_Angeles",
  "London": "Europe/London",
  "Dublin": "Europe/Dublin",
  "Paris": "Europe/Paris",
  "Berlin": "Europe/Berlin",
  "Rome": "Europe/Rome",
  "Madrid": "Europe/Madrid",
  "Mumbai": "Asia/Kolkata",
  "Kolkata": "Asia/Kolkata",
  "Chennai": "Asia/Kolkata",
  "New Delhi": "Asia/Kolkata",
  "India": "Asia/Kolkata",
  "Singapore": "Asia/Singapore",
  "Hong Kong": "Asia/Hong_Kong",
  "Tokyo": "Asia/Tokyo",
  "Sydney": "Australia/Sydney"
};

exports = {
  onAppInstallCallback: async function(payload) {
    try {
      await ensureStoredConfig(payload);
      await ensureAutoScanSchedule(payload);
      await log("install", "installed", { host: safeHost(payload), config: publicConfig(await loadConfig(payload)) });
      renderData(null, { message: "Business hours automation installed." });
    } catch (error) {
      console.log("Install warning: " + errorMessage(error));
      renderData(null, { message: "Installed. Configure app settings from Freshdesk Admin > Apps." });
    }
  },

  onAppUninstallCallback: async function() {
    await log("uninstall", "uninstalled", {});
    renderData(null, { message: "Uninstalled." });
  },

  getSidebarData: async function(payload) {
    try {
      const request = payload && payload.data ? payload.data : payload || {};
      const ticketId = request.ticketId || request.ticket_id || "";
      const config = await loadConfig(payload);
      try { await ensureAutoScanSchedule(payload, config); }
      catch (scheduleRepairError) { console.log("RA autoscan repair warning from sidebar: " + errorMessage(scheduleRepairError)); }
      const warnings = [];
      let businessHours = [];
      let statuses = [];
      let priorities = [];
      let selectedCalendar = null;
      let selectedCalendarDetails = null;
      let currentTicket = null;
      let currentJob = null;
      let previewDueAt = null;
      let previewRule = null;

      try { businessHours = await listBusinessHours(payload); }
      catch (error) { warnings.push("Business Hours fetch failed: " + errorMessage(error)); }

      try { statuses = await listStatuses(payload); }
      catch (error) { warnings.push("Ticket status fetch failed: " + errorMessage(error)); statuses = defaultStatuses(); }

      priorities = [];

      try {
        if (businessHours.length) {
          selectedCalendar = businessHours.find(function(item) { return item.isDefault; }) || businessHours[0];
          if (selectedCalendar && selectedCalendar.id) {
            try {
              let detail = selectedCalendar;
              try { detail = await getBusinessHour(payload, selectedCalendar.id); }
              catch (detailError) { warnings.push("Detailed Business Hours fetch warning: " + errorMessage(detailError)); }
              selectedCalendarDetails = calendarFromBusinessHour(detail || selectedCalendar);
            } catch (detailNormalizeError) {
              warnings.push("Business Hours detail display warning: " + errorMessage(detailNormalizeError));
            }
          }
        }
      } catch (error) { warnings.push("Business Hours selection warning: " + errorMessage(error)); }

      if (ticketId) {
        try {
          const freshTicket = await fetchTicket(payload, ticketId);
          currentTicket = ticketSummary(freshTicket, statuses, priorities);
          currentJob = await findJobForTicket(ticketId, freshTicket);

          // The job store/cache is not the source of truth. Whenever the sidebar opens,
          // compare the pending timer with the live Freshdesk ticket. If the ticket no
          // longer matches the configured trigger rule, remove it from the schedule.
          if (config.enabled) {
            const sidebarRule = matchingRuleForTicket(freshTicket, statuses, priorities, config);
            if (currentJob && currentJob.status === "pending") {
              const sameRule = sidebarRule && String(currentJob.ruleId || "") === String(sidebarRule.id || "");
              if (!sameRule) {
                await cancelJob(ticketId, "current_ticket_live_status_changed");
                currentJob = null;
                warnings.push("Current ticket no longer matches the automation rule, so its timer was removed from the schedule.");
              }
            }
            if (sidebarRule && (!currentJob || currentJob.status !== "pending")) {
              if (!(currentJob && currentJob.status === "completed" && String(currentJob.ruleId || "") === String(sidebarRule.id || ""))) {
                try {
                  currentJob = await scheduleTicket(payload, freshTicket, "ticket_sidebar_auto_match", config, statuses, null, sidebarRule);
                  warnings.push("Current ticket matched the automation rule and was scheduled automatically.");
                } catch (scheduleError) {
                  warnings.push("Current ticket auto-schedule warning: " + errorMessage(scheduleError));
                }
              }
            }
          }

          if (!currentJob && config.enabled) {
            previewRule = matchingRuleForTicket(freshTicket, statuses, priorities, config);
            if (previewRule) {
              try {
                const calendar = await resolveBusinessCalendar(payload, config);
                if (positiveNumberOrBlank(previewRule.delayBusinessHours)) {
                  previewDueAt = addBusinessMinutes(new Date().toISOString(), Number(previewRule.delayBusinessHours) * 60, calendar);
                }
              } catch (error) {
                warnings.push("Preview due time could not be calculated: " + errorMessage(error));
              }
            }
          }
        } catch (error) { warnings.push("Current ticket fetch failed: " + errorMessage(error)); }
      }

      // UI list must be a stable scheduled snapshot. Live status reconciliation runs in
      // ticket events, autoscan, and due-job execution, not during display rendering.
      const affectedTickets = await listPendingJobs(payload, statuses, MAX_DISPLAY_JOBS, config, { liveValidationLimit: 0 });
      if (ticketId && (!currentJob || currentJob.status !== "pending")) {
        const affectedJob = findJobSummaryForTicket(affectedTickets, ticketId, currentTicket);
        if (affectedJob) currentJob = affectedJob;
      }
      renderData(null, {
        config: publicConfig(config),
        businessHours: businessHours,
        selectedCalendar: selectedCalendar,
        selectedCalendarDetails: selectedCalendarDetails,
        statuses: statuses,
        priorities: priorities,
        currentTicket: currentTicket,
        currentJob: currentJob,
        previewDueAt: previewDueAt,
        previewRule: previewRule ? publicRule(previewRule) : null,
        affectedTickets: affectedTickets,
        warnings: warnings,
        generatedAt: new Date().toISOString()
      });
    } catch (error) {
      renderData(toError(error));
    }
  },

  saveAutomationConfig: async function(payload) {
    try {
      const request = payload && payload.data ? payload.data : payload || {};
      const incoming = request.config || request || {};
      const statuses = await safeListStatuses(payload);
      let businessHours = [];
      try { businessHours = await listBusinessHours(payload); } catch (_e) { businessHours = []; }
      const config = normalizeConfigPayload(incoming, await loadConfig(payload));
      const rules = normalizeRules(config.rules || []);
      rules.forEach(function(rule) {
        if (!rule.triggerStatusName || !rule.targetStatusName) throw new Error("Select both ticket statuses before saving the automation rule.");
        if (!positiveNumberOrBlank(rule.delayBusinessHours)) throw new Error("Enter the number of business hours before saving the automation rule.");
        const triggerStatusId = idForName(statuses, rule.triggerStatusName);
        if (!triggerStatusId) throw new Error("Trigger status was not found in Freshdesk: " + rule.triggerStatusName);
        if (!idForName(statuses, rule.targetStatusName)) {
          throw new Error("Target status was not found in Freshdesk: " + rule.targetStatusName);
        }
      });
      if (!businessHours.length) throw new Error("Freshdesk Business Hours were not found. Check the admin API key/domain.");
      const savedConfig = await saveConfig(config);
      await ensureAutoScanSchedule(payload, savedConfig);
      let scanResult = { scheduled: [], alreadyScheduled: [], skipped: [], found: 0, affectedTickets: [] };
      if (!savedConfig.enabled) {
        try {
          const cancelled = await cancelAllPendingJobs("automation_disabled");
          scanResult.skipped = [{ reason: "automation_disabled", cancelled: cancelled.cancelled || 0 }];
        } catch (cancelError) {
          scanResult.skipped = [{ reason: "automation_disabled_cancel_warning_" + errorMessage(cancelError) }];
        }
      }
      if (savedConfig.enabled) {
        try {
          scanResult = await scanMatchingTicketsInternal(payload, savedConfig, "save_auto_scan");
          try { scanResult.affectedTickets = await listPendingJobs(payload, statuses, MAX_DISPLAY_JOBS, savedConfig, { liveValidationLimit: 0 }); } catch (_e) { scanResult.affectedTickets = []; }
          if (!scanResult.affectedTickets || !scanResult.affectedTickets.length) {
            scanResult.affectedTickets = buildAffectedTicketsFromScan(scanResult.scheduled, scanResult.alreadyScheduled);
          }
        } catch (scanError) {
          scanResult = { scheduled: [], alreadyScheduled: [], skipped: [{ reason: errorMessage(scanError) }], found: 0, affectedTickets: [] };
        }
      }
      await log("config", "saved_from_sidebar", publicConfig(savedConfig));
      renderData(null, Object.assign({ saved: true, config: publicConfig(savedConfig), ruleCount: rules.length, autoScheduling: true }, scanResult));
    } catch (error) {
      renderData(toError(error));
    }
  },

  saveAutomationEnabledState: async function(payload) {
    try {
      const request = payload && payload.data ? payload.data : payload || {};
      const enabled = boolValue(request.enabled !== undefined ? request.enabled : request.enabledText, false);
      await saveEnabledStateRecord(enabled, request.enabledStateSavedAtMs || undefined);
      const current = await loadConfig(payload);
      const savedConfig = await saveConfig(Object.assign({}, current, {
        enabled: enabled,
        enabledText: enabled ? "true" : "false",
        enabledStateSavedAtMs: request.enabledStateSavedAtMs || current.enabledStateSavedAtMs || Date.now()
      }));

      let cancelled = 0;
      if (!enabled) {
        try {
          const result = await cancelAllPendingJobs("automation_disabled_toggle");
          cancelled = result && result.cancelled ? Number(result.cancelled) : 0;
        } catch (cancelError) {
          console.log("Automation disable cleanup warning: " + errorMessage(cancelError));
        }
      }

      await ensureAutoScanSchedule(payload, savedConfig);
      await log("config", enabled ? "enabled_from_toggle" : "disabled_from_toggle", publicConfig(savedConfig));
      renderData(null, { saved: true, enabled: enabled, enabledText: enabled ? "true" : "false", cancelled: cancelled, config: publicConfig(savedConfig) });
    } catch (error) {
      renderData(toError(error));
    }
  },

  scheduleCurrentTicket: async function(payload) {
    try {
      const request = payload && payload.data ? payload.data : payload || {};
      const ticketId = request.ticketId || request.ticket_id;
      if (!ticketId) throw new Error("No ticket ID was provided. Open the app from a ticket sidebar.");
      const config = request.config
        ? normalizeConfigPayload(request.config, await loadConfig(payload))
        : await loadConfig(payload);
      const statuses = await safeListStatuses(payload);
      const ticket = await fetchTicket(payload, ticketId);
      const record = await scheduleTicket(payload, ticket, "manual_sidebar", config, statuses);
      renderData(null, { scheduled: true, record: record });
    } catch (error) {
      renderData(toError(error));
    }
  },

  cancelCurrentTicketAutomation: async function(payload) {
    try {
      const request = payload && payload.data ? payload.data : payload || {};
      const ticketId = request.ticketId || request.ticket_id;
      if (!ticketId) throw new Error("No ticket ID was provided. Open the app from a ticket sidebar.");
      await cancelJob(ticketId, "manual_sidebar_cancel");
      renderData(null, { cancelled: true, ticketId: String(ticketId) });
    } catch (error) {
      renderData(toError(error));
    }
  },

  scanAndScheduleTickets: async function(payload) {
    try {
      const request = payload && payload.data ? payload.data : payload || {};
      // Prefer the live sidebar form config when scan is clicked. This prevents a stale
      // stored disabled config from blocking a scan when the UI has just been enabled.
      let config = request.config
        ? normalizeConfigPayload(request.config, await loadConfig(payload))
        : await loadConfig(payload);
      if (request.config) {
        config = await saveConfig(config);
      }
      await ensureAutoScanSchedule(payload, config);
      if (!config.enabled) throw new Error("Automation is disabled. Enable it and save the rule first.");
      const rules = sortedActiveRules(config);
      if (!rules.length) throw new Error("No active automation rules are configured.");
      const statuses = await safeListStatuses(payload);
      const priorities = [];
      const calendar = await resolveBusinessCalendar(payload, config);
      const scheduled = [];
      const alreadyScheduled = [];
      const skipped = [];
      const seenTickets = {};
      let found = 0;

      for (let r = 0; r < rules.length; r += 1) {
        const rule = rules[r];
        const triggerStatusId = idForName(statuses, rule.triggerStatusName);
        if (!triggerStatusId) {
          skipped.push({ ruleName: rule.name, reason: "trigger_status_not_found" });
          continue;
        }
        const tickets = await searchTicketsByStatus(payload, triggerStatusId, MAX_SCAN_PAGES, MAX_SCAN_TICKETS);
        found += tickets.length;
        for (let i = 0; i < tickets.length; i += 1) {
          const item = tickets[i] || {};
          const ticketId = item.id || item.ticket_id;
          if (!ticketId) continue;
          if (seenTickets[String(ticketId)]) continue;
          let ticket = Object.assign({}, item, { id: ticketId });
          if (ticket.status === undefined || ticket.status === null) ticket.status = triggerStatusId;
          if (!ruleMatchesTicket(rule, ticket, statuses, priorities)) {
            if (!isAnyPriority(rule.priorityName)) {
              try {
                ticket = await fetchTicket(payload, ticketId);
              } catch (fetchError) {
                skipped.push({ ticketId: String(ticketId), ruleName: rule.name, reason: "ticket_fetch_failed_" + errorMessage(fetchError) });
                continue;
              }
            }
          }
          if (!ruleMatchesTicket(rule, ticket, statuses, priorities)) {
            skipped.push({ ticketId: String(ticketId), ruleName: rule.name, reason: "ticket_did_not_match_rule" });
            continue;
          }
          seenTickets[String(ticketId)] = true;
          const existing = await dbGet(jobKey(ticketId), null);
          if (existing && existing.status === "pending") {
            const currentName = statusNameById(statuses, ticket.status) || rule.triggerStatusName;
            const updatedExisting = await resyncExistingJob(payload, existing, ticket, config, statuses, calendar, rule);
            await addJobIndex(ticketId);
            await upsertJobCache(updatedExisting, ticket, currentName);
            alreadyScheduled.push({
              ticketId: String(ticketId),
              subject: item.subject || updatedExisting.subject || "",
              dueAt: updatedExisting.dueAt || "",
              ruleName: rule.name,
              triggerStatusName: rule.triggerStatusName,
              priorityName: rule.priorityName,
              targetStatusName: rule.targetStatusName,
              reason: "already_scheduled_resynced_to_current_rule"
            });
            continue;
          }
          try {
            const record = await scheduleTicket(payload, ticket, "manual_scan", config, statuses, calendar, rule);
            scheduled.push({
              ticketId: String(ticketId),
              subject: ticket.subject || "",
              dueAt: record.dueAt,
              ruleName: rule.name,
              triggerStatusName: rule.triggerStatusName,
              priorityName: rule.priorityName,
              targetStatusName: rule.targetStatusName
            });
          } catch (error) {
            skipped.push({ ticketId: String(ticketId), ruleName: rule.name, reason: errorMessage(error) });
          }
        }
      }
      let affectedTickets = [];
      try { affectedTickets = await listPendingJobs(payload, statuses, MAX_DISPLAY_JOBS, config, { liveValidationLimit: 0 }); } catch (_e) { affectedTickets = []; }
      if (!affectedTickets.length) affectedTickets = buildAffectedTicketsFromScan(scheduled, alreadyScheduled);
      renderData(null, { scheduled: scheduled, alreadyScheduled: alreadyScheduled, skipped: skipped, found: found, affectedTickets: affectedTickets, displayLimit: MAX_DISPLAY_JOBS, scanPages: MAX_SCAN_PAGES });
    } catch (error) {
      renderData(toError(error));
    }
  },

  cancelAllTicketAutomations: async function(payload) {
    try {
      const result = await cancelAllPendingJobs("manual_sidebar_cancel_all");
      renderData(null, result);
    } catch (error) {
      renderData(toError(error));
    }
  },

  onTicketCreateCallback: async function(payload) {
    await handleTicketEvent(payload, "ticket_created");
  },

  onTicketUpdateCallback: async function(payload) {
    await handleTicketEvent(payload, "ticket_updated");
  },

  onScheduledEventCallback: async function(payload) {
    const data = payload && payload.data ? payload.data : {};
    if (data && data.type === "auto_status_scan") {
      await runAutoStatusScan(payload);
      return;
    }
    if (data && data.type === "ticket_event_catchup_scan") {
      await runTicketEventCatchup(payload, data.ticketId || data.ticket_id || "");
      return;
    }
    await runDueJob(payload);
  }
};

async function handleTicketEvent(payload, eventName) {
  const fallbackId = extractTicketId(payload);
  try {
    const config = await loadConfig(payload);
    if (!config.enabled) {
      console.log("RA skipped " + eventName + ": automation disabled.");
      return;
    }
    try { await ensureAutoScanSchedule(payload, config); }
    catch (scheduleRepairError) { console.log("RA autoscan repair warning from " + eventName + ": " + errorMessage(scheduleRepairError)); }

    const statuses = await safeListStatuses(payload);
    const priorities = [];
    const eventTicket = buildEventTicketCandidate(payload, fallbackId);
    const lookupTicketId = fallbackId || (eventTicket && (eventTicket.id || eventTicket.ticket_id || eventTicket.ticketId));
    const changedStatus = changedStatusValue(payload);

    await log(lookupTicketId || "ticket_event", eventName + "_received", {
      ticketId: lookupTicketId || "",
      eventStatus: eventTicket ? statusDisplayName(eventTicket, statuses, "") : "",
      changedStatus: changedStatus === undefined || changedStatus === null ? "" : String(extractScalarValue(changedStatus)),
      host: safeHost(payload),
      hasEventTicket: Boolean(eventTicket)
    });

    if (!lookupTicketId && (!eventTicket || !eventTicket.id)) {
      console.log("RA skipped " + eventName + ": no ticket id in payload. Running safety scan instead.");
      await runAutoStatusScan(payload);
      return;
    }

    let liveTicket = null;
    try {
      liveTicket = await fetchTicket(payload, lookupTicketId || (eventTicket && eventTicket.id));
    } catch (fetchError) {
      // Do not fail the event path just because the REST API is temporarily stale or the
      // event payload only has currentHost. The onTicketUpdate payload itself contains the
      // ticket and the changed status, so it can still schedule immediately.
      console.log("RA " + eventName + " live ticket fetch warning: " + errorMessage(fetchError));
    }

    const selected = selectEventTicketCandidate(liveTicket, eventTicket, statuses, priorities, config);
    const ticket = selected.ticket;
    const matchingRule = selected.rule;
    const effectiveTicketId = String((ticket && (ticket.id || ticket.ticket_id || ticket.ticketId)) || lookupTicketId || "");
    const existingInfo = await findJobRecordForTicket(effectiveTicketId, ticket);
    const existing = existingInfo.record;
    const existingTicketId = existingInfo.ticketId || effectiveTicketId;

    if (!matchingRule) {
      if (existing && existing.status === "pending") {
        await cancelJob(existingTicketId, "ticket_no_longer_matches_any_rule");
      }
      // Freshdesk may deliver the event before the REST/search index reflects the new
      // status. Retry this same ticket shortly instead of waiting for the periodic scan.
      await scheduleTicketEventCatchup(payload, effectiveTicketId || lookupTicketId, "no_matching_rule_on_event", TICKET_EVENT_CATCHUP_DELAY_SECONDS);
      return;
    }

    if (existing && existing.status === "pending") {
      if (String(existing.ruleId || "") === String(matchingRule.id || "")) {
        console.log("RA already has a pending job for ticket " + effectiveTicketId + ".");
        await addJobIndex(existingTicketId);
        await upsertJobCache(existing, ticket, statusDisplayName(ticket, statuses, matchingRule.triggerStatusName));
        await upsertScheduledSnapshot(existing, ticket, statusDisplayName(ticket, statuses, matchingRule.triggerStatusName));
        return;
      }
      await cancelJob(existingTicketId, "matched_higher_priority_rule");
    }

    if (existing && existing.status && existing.status !== "pending") {
      console.log("RA found previous non-pending job for ticket " + effectiveTicketId + " with status " + existing.status + "; scheduling again because the ticket currently matches the rule.");
    }

    const record = await scheduleTicket(payload, ticket || { id: effectiveTicketId, status: idForName(statuses, matchingRule.triggerStatusName) }, eventName, config, statuses, null, matchingRule);
    try { await $schedule.delete({ name: ticketCatchupScheduleName(record.ticketId) }); } catch (_e) {}
    await log(record.ticketId, eventName + "_scheduled_immediately", { ticketId: record.ticketId, dueAt: record.dueAt, ruleName: matchingRule.name, selectedSource: selected.source });
    console.log("RA scheduled ticket " + record.ticketId + " at " + record.dueAt + " using rule " + matchingRule.name + " from " + selected.source);
  } catch (error) {
    console.log("RA event error: " + errorMessage(error));
    try {
      if (fallbackId) await scheduleTicketEventCatchup(payload, fallbackId, "event_error", TICKET_EVENT_CATCHUP_DELAY_SECONDS);
    } catch (_catchupError) {}
  }
}


function buildEventTicketCandidate(payload, fallbackTicketId) {
  const raw = extractTicket(payload);
  const ticket = raw && typeof raw === "object" ? Object.assign({}, raw) : {};
  const id = fallbackTicketId || ticket.id || ticket.ticket_id || ticket.ticketId || ticket.display_id;
  if (id !== undefined && id !== null && String(id).trim() !== "") ticket.id = String(id).trim();

  // Freshworks onTicketUpdate includes ticket.changes, where each changed attribute is
  // [oldValue, newValue]. Apply the new status to the event candidate so a status-change
  // event can schedule immediately even if a follow-up REST fetch is stale.
  const changed = changedStatusValue(payload);
  if (changed !== undefined && changed !== null && String(extractScalarValue(changed)).trim() !== "") {
    applyStatusValueToTicket(ticket, changed);
  }

  if (!Object.keys(ticket).length || (!ticket.id && !ticket.status && !ticket.status_name && !ticket.statusName && !ticket.status_label && !ticket.statusLabel)) return null;
  return ticket;
}

function changedStatusValue(payload) {
  const data = payload && payload.data ? payload.data : (payload || {});
  const ticket = data.ticket || data.ticketData || data.ticket_data || null;
  const sources = [
    ticket && ticket.changes,
    data.changes,
    data.changed_values,
    data.changedValues,
    data.ticket_changes,
    data.ticketChanges,
    data.ticketEvent && data.ticketEvent.changes,
    data.ticket_event && data.ticket_event.changes,
    data.ticketEvent && data.ticketEvent.ticket && data.ticketEvent.ticket.changes,
    data.ticket_event && data.ticket_event.ticket && data.ticket_event.ticket.changes
  ];
  const keys = ["status", "status_id", "statusId", "ticket_status", "ticketStatus", "status_name", "statusName"];
  for (let i = 0; i < sources.length; i += 1) {
    const changes = sources[i];
    if (!changes || typeof changes !== "object") continue;
    for (let k = 0; k < keys.length; k += 1) {
      if (changes[keys[k]] === undefined || changes[keys[k]] === null) continue;
      return changeNewValue(changes[keys[k]]);
    }
  }
  return undefined;
}

function changeNewValue(value) {
  if (Array.isArray(value)) return value.length > 1 ? value[value.length - 1] : value[0];
  if (value && typeof value === "object") {
    if (value.new !== undefined) return value.new;
    if (value.new_value !== undefined) return value.new_value;
    if (value.newValue !== undefined) return value.newValue;
    if (value.current !== undefined) return value.current;
    if (value.to !== undefined) return value.to;
  }
  return value;
}

function applyStatusValueToTicket(ticket, value) {
  const scalar = extractScalarValue(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = value.id || value.value || value.status_id || value.statusId;
    const name = value.name || value.label || value.display_name || value.displayName;
    if (id !== undefined && id !== null && String(id).trim() !== "") ticket.status = id;
    if (name !== undefined && name !== null && String(name).trim() !== "") ticket.status_name = String(name).trim();
    return;
  }
  if (scalar === undefined || scalar === null) return;
  const text = String(scalar).trim();
  if (!text) return;
  if (/^\d+$/.test(text)) ticket.status = Number(text);
  else ticket.status_name = text;
}

function extractScalarValue(value) {
  if (Array.isArray(value)) return value.length ? extractScalarValue(value[value.length - 1]) : "";
  if (value && typeof value === "object") {
    if (value.id !== undefined) return value.id;
    if (value.value !== undefined) return value.value;
    if (value.status_id !== undefined) return value.status_id;
    if (value.statusId !== undefined) return value.statusId;
    if (value.name !== undefined) return value.name;
    if (value.label !== undefined) return value.label;
    if (value.display_name !== undefined) return value.display_name;
    if (value.displayName !== undefined) return value.displayName;
  }
  return value;
}


function selectEventTicketCandidate(liveTicket, eventTicket, statuses, priorities, config) {
  const candidates = [];
  if (liveTicket) candidates.push({ ticket: liveTicket, source: "live" });
  if (eventTicket) candidates.push({ ticket: eventTicket, source: "event_payload" });

  // Prefer any candidate that currently matches the rule. This avoids missing a valid
  // status-change event when the immediate Freshdesk REST fetch still returns the old
  // status for a short period.
  for (let i = 0; i < candidates.length; i += 1) {
    const rule = matchingRuleForTicket(candidates[i].ticket, statuses, priorities, config);
    if (rule) return { ticket: candidates[i].ticket, rule: rule, source: candidates[i].source };
  }

  return { ticket: liveTicket || eventTicket || null, rule: null, source: liveTicket ? "live" : (eventTicket ? "event_payload" : "none") };
}

async function findJobRecordForTicket(ticketId, ticket) {
  const candidates = ticketIdCandidates(ticketId, ticket);
  for (let i = 0; i < candidates.length; i += 1) {
    const id = String(candidates[i]);
    const record = await dbGet(jobKey(id), null);
    if (record) return { ticketId: id, record: record };
  }
  return { ticketId: candidates.length ? candidates[0] : String(ticketId || ""), record: null };
}

async function scheduleTicketEventCatchup(payload, ticketId, reason, delaySeconds) {
  const id = String(ticketId || "").trim();
  if (!id) return;
  const seconds = Number(delaySeconds || TICKET_EVENT_CATCHUP_DELAY_SECONDS);
  const dueAt = new Date(Date.now() + Math.max(10, seconds) * 1000).toISOString();
  try {
    await upsertOneTimeSchedule(ticketCatchupScheduleName(id), { type: "ticket_event_catchup_scan", ticketId: id, reason: reason || "ticket_event_catchup" }, dueAt);
    await log(id, "ticket_event_catchup_scheduled", { ticketId: id, reason: reason || "ticket_event_catchup", dueAt: dueAt, delaySeconds: Math.max(10, seconds) });
  } catch (error) {
    console.log("RA could not schedule ticket event catch-up for " + id + ": " + errorMessage(error));
  }
}

async function runTicketEventCatchup(payload, ticketId) {
  const id = String(ticketId || "").trim();
  try {
    const config = await loadConfig(payload);
    if (!config || !config.enabled) return;
    const statuses = await safeListStatuses(payload);
    const priorities = [];
    let ticket = null;
    try { ticket = await fetchTicket(payload, id); }
    catch (fetchError) {
      console.log("RA ticket catch-up fetch failed for " + id + ": " + errorMessage(fetchError) + ". Running full safety scan.");
      await runAutoStatusScan(payload);
      return;
    }
    const matchingRule = matchingRuleForTicket(ticket, statuses, priorities, config);
    if (!matchingRule) {
      console.log("RA ticket catch-up skipped " + id + ": ticket no longer matches the automation rule.");
      return;
    }
    const existingInfo = await findJobRecordForTicket(ticket.id || id, ticket);
    const existing = existingInfo.record;
    const existingTicketId = existingInfo.ticketId || String(ticket.id || id);
    if (existing && existing.status === "pending") {
      if (String(existing.ruleId || "") === String(matchingRule.id || "")) {
        await addJobIndex(existingTicketId);
        await upsertJobCache(existing, ticket, statusDisplayName(ticket, statuses, matchingRule.triggerStatusName));
        await upsertScheduledSnapshot(existing, ticket, statusDisplayName(ticket, statuses, matchingRule.triggerStatusName));
        console.log("RA ticket catch-up found existing pending job for " + existingTicketId + ".");
        return;
      }
      await cancelJob(existingTicketId, "catchup_matched_different_rule");
    }
    const record = await scheduleTicket(payload, ticket, "ticket_event_catchup_scan", config, statuses, null, matchingRule);
    console.log("RA ticket catch-up scheduled ticket " + record.ticketId + " at " + record.dueAt + ".");
  } catch (error) {
    console.log("RA ticket catch-up error for " + id + ": " + errorMessage(error));
    try { await runAutoStatusScan(payload); } catch (_scanError) {}
  }
}


async function scheduleTicket(payload, ticket, source, config, statuses, calendarOverride, ruleOverride) {
  const effectiveConfig = config || await loadConfig(payload);
  if (!effectiveConfig.enabled) throw new Error("Automation is disabled.");

  const effectiveStatuses = statuses || await safeListStatuses(payload);
  const priorities = [];
  const rule = ruleOverride || matchingRuleForTicket(ticket, effectiveStatuses, priorities, effectiveConfig);
  if (!rule) throw new Error("Ticket does not match any active automation rule.");

  if (!ruleMatchesTicket(rule, ticket, effectiveStatuses, priorities)) {
    throw new Error("Ticket does not match rule: " + rule.name);
  }

  const targetStatusId = idForName(effectiveStatuses, rule.targetStatusName);
  if (rule.changeStatus && !targetStatusId) {
    throw new Error("Target status was not found in Freshdesk: " + rule.targetStatusName);
  }

  if (!positiveNumberOrBlank(rule.delayBusinessHours)) {
    throw new Error("Delay in business hours is not configured.");
  }
  const calendar = calendarOverride || await resolveBusinessCalendar(payload, effectiveConfig);
  const dueAt = addBusinessMinutes(new Date().toISOString(), Number(rule.delayBusinessHours) * 60, calendar);
  const record = {
    status: "pending",
    ticketId: String(ticket.id),
    source: source || "event",
    ruleId: String(rule.id || "rule_1"),
    ruleName: rule.name || "Automation rule",
    rulePriorityOrder: Number(rule.priorityOrder || 1),
    triggerStatusName: rule.triggerStatusName,
    priorityName: rule.priorityName || ANY_PRIORITY,
    targetStatusName: rule.targetStatusName,
    targetStatusId: targetStatusId || null,
    delayBusinessHours: Number(rule.delayBusinessHours),
    businessHoursId: String(calendar.id || effectiveConfig.businessHoursId || "default"),
    businessHoursName: calendar.name || "Freshdesk Business Hours",
    timerMode: "business_hours",
    sendPublicReply: false,
    replyBody: DEFAULT_REPLY,
    changeStatus: true,
    createdAt: new Date().toISOString(),
    dueAt: dueAt,
    scheduleName: scheduleName(ticket.id)
  };
  await $db.set(jobKey(ticket.id), record);
  await addJobIndex(ticket.id);
  const scheduledStatusName = statusDisplayName(ticket, effectiveStatuses, rule.triggerStatusName);
  await upsertJobCache(record, ticket, scheduledStatusName);
  await upsertScheduledSnapshot(record, ticket, scheduledStatusName);
  await upsertOneTimeSchedule(record.scheduleName, { ticketId: String(ticket.id) }, record.dueAt);
  await log(ticket.id, "scheduled", record);
  return record;
}


async function resyncExistingJob(payload, existing, ticket, config, statuses, calendarOverride, ruleOverride) {
  const effectiveConfig = config || await loadConfig(payload);
  const effectiveStatuses = statuses || await safeListStatuses(payload);
  const priorities = [];
  const rule = ruleOverride || matchingRuleForTicket(ticket, effectiveStatuses, priorities, effectiveConfig);
  if (!rule) throw new Error("Ticket no longer matches any active automation rule.");
  const targetStatusId = idForName(effectiveStatuses, rule.targetStatusName);
  if (!positiveNumberOrBlank(rule.delayBusinessHours)) {
    throw new Error("Delay in business hours is not configured.");
  }
  const calendar = calendarOverride || await resolveBusinessCalendar(payload, effectiveConfig);
  const startIso = existing.createdAt || new Date().toISOString();
  const dueAt = addBusinessMinutes(startIso, Number(rule.delayBusinessHours) * 60, calendar);
  const updated = Object.assign({}, existing, {
    ruleId: String(rule.id || "rule_1"),
    ruleName: rule.name || "Automation rule",
    rulePriorityOrder: Number(rule.priorityOrder || 1),
    triggerStatusName: rule.triggerStatusName,
    priorityName: rule.priorityName || ANY_PRIORITY,
    targetStatusName: rule.targetStatusName,
    targetStatusId: targetStatusId || null,
    delayBusinessHours: Number(rule.delayBusinessHours),
    businessHoursId: String(calendar.id || effectiveConfig.businessHoursId || "default"),
    businessHoursName: calendar.name || "Freshdesk Business Hours",
    timerMode: "business_hours",
    sendPublicReply: false,
    replyBody: DEFAULT_REPLY,
    changeStatus: true,
    dueAt: dueAt,
    resyncedAt: new Date().toISOString()
  });
  await $db.set(jobKey(ticket.id || existing.ticketId), updated);
  await upsertScheduledSnapshot(updated, ticket, statusDisplayName(ticket, effectiveStatuses, rule.triggerStatusName));
  await upsertOneTimeSchedule(updated.scheduleName || scheduleName(ticket.id || existing.ticketId), { ticketId: String(ticket.id || existing.ticketId) }, updated.dueAt);
  await log(ticket.id || existing.ticketId, "resynced", updated);
  return updated;
}


async function ensureAutoScanSchedule(payload, configOverride) {
  const config = configOverride || await loadConfig(payload);
  try {
    if (!config || !config.enabled || !sortedActiveRules(config).length) {
      // Only delete the recurring scan when the latest explicit status is disabled.
      // If config loading briefly falls back to a default/unknown disabled value, do
      // not tear down an existing enabled schedule during a refresh.
      const explicitState = await loadEnabledStateRecord();
      if (explicitState && explicitState.enabled === false) {
        try { await $schedule.delete({ name: AUTO_SCAN_SCHEDULE_NAME }); } catch (_e) {}
      }
      return;
    }
    const nextAt = new Date(Date.now() + (AUTO_SCAN_INTERVAL_MINUTES * 60 + AUTO_SCAN_START_BUFFER_SECONDS) * 1000).toISOString();
    await upsertSchedule(AUTO_SCAN_SCHEDULE_NAME, { type: "auto_status_scan" }, nextAt, { time_unit: "minutes", frequency: AUTO_SCAN_INTERVAL_MINUTES });
  } catch (error) {
    console.log("RA auto status scan schedule warning: " + errorMessage(error));
  }
}

async function runAutoStatusScan(payload) {
  try {
    const config = await loadConfig(payload);
    if (!config || !config.enabled) {
      const explicitState = await loadEnabledStateRecord();
      if (explicitState && explicitState.enabled === false) {
        try { await $schedule.delete({ name: AUTO_SCAN_SCHEDULE_NAME }); } catch (_e) {}
      }
      console.log("RA auto status scan skipped: automation disabled or status unavailable.");
      return;
    }
    const statuses = await safeListStatuses(payload);
    const priorities = [];
    const calendar = await resolveBusinessCalendar(payload, config);
    const reconcile = await reconcilePendingJobs(payload, config, statuses, priorities, calendar, "auto_status_scan", MAX_RECONCILE_JOBS);
    const result = await scanMatchingTicketsInternal(payload, config, "auto_status_scan", statuses, calendar);
    console.log("RA auto status scan complete. Found " + result.found + ", scheduled " + result.scheduled.length + ", resynced " + result.alreadyScheduled.length + ", removed stale " + reconcile.removed.length + ", skipped " + result.skipped.length + ".");
  } catch (error) {
    console.log("RA auto status scan error: " + errorMessage(error));
  } finally {
    await ensureAutoScanSchedule(payload);
  }
}

async function scanMatchingTicketsInternal(payload, config, source, statusesOverride, calendarOverride) {
  if (!config.enabled) throw new Error("Automation is disabled. Enable it and save the rule first.");
  const rules = sortedActiveRules(config);
  if (!rules.length) throw new Error("No active automation rule is configured.");
  const statuses = statusesOverride || await safeListStatuses(payload);
  const priorities = [];
  const calendar = calendarOverride || await resolveBusinessCalendar(payload, config);
  const scheduled = [];
  const alreadyScheduled = [];
  const skipped = [];
  const seenTickets = {};
  const isAutoStatusScan = String(source || "") === "auto_status_scan";
  const scanPages = MAX_SCAN_PAGES;
  const scanTickets = MAX_SCAN_TICKETS;
  let found = 0;

  for (let r = 0; r < rules.length; r += 1) {
    const rule = rules[r];
    const triggerStatusId = idForName(statuses, rule.triggerStatusName);
    if (!triggerStatusId) {
      skipped.push({ ruleName: rule.name, reason: "trigger_status_not_found" });
      continue;
    }
    const tickets = await searchTicketsByStatus(payload, triggerStatusId, scanPages, scanTickets);
    found += tickets.length;
    for (let i = 0; i < tickets.length; i += 1) {
      const item = tickets[i] || {};
      const ticketId = item.id || item.ticket_id;
      if (!ticketId) continue;
      if (seenTickets[String(ticketId)]) continue;
      let ticket = Object.assign({}, item, { id: ticketId });
      if (ticket.status === undefined || ticket.status === null) ticket.status = triggerStatusId;
      if (!ruleMatchesTicket(rule, ticket, statuses, priorities)) {
        skipped.push({ ticketId: String(ticketId), ruleName: rule.name, reason: "ticket_did_not_match_rule" });
        continue;
      }
      seenTickets[String(ticketId)] = true;
      const existing = await dbGet(jobKey(ticketId), null);
      if (existing && existing.status === "pending") {
        const currentName = statusNameById(statuses, ticket.status) || rule.triggerStatusName;
        const updatedExisting = await resyncExistingJob(payload, existing, ticket, config, statuses, calendar, rule);
        await addJobIndex(ticketId);
        await upsertJobCache(updatedExisting, ticket, currentName);
        alreadyScheduled.push({
          ticketId: String(ticketId),
          subject: item.subject || updatedExisting.subject || "",
          dueAt: updatedExisting.dueAt || "",
          ruleName: rule.name,
          triggerStatusName: rule.triggerStatusName,
          targetStatusName: rule.targetStatusName,
          reason: "already_scheduled_resynced_to_current_rule"
        });
        continue;
      }
      try {
        const record = await scheduleTicket(payload, ticket, source || "manual_scan", config, statuses, calendar, rule);
        scheduled.push({
          ticketId: String(ticketId),
          subject: ticket.subject || "",
          dueAt: record.dueAt,
          ruleName: rule.name,
          triggerStatusName: rule.triggerStatusName,
          targetStatusName: rule.targetStatusName
        });
      } catch (error) {
        skipped.push({ ticketId: String(ticketId), ruleName: rule.name, reason: errorMessage(error) });
      }
    }
  }
  return { scheduled: scheduled, alreadyScheduled: alreadyScheduled, skipped: skipped, found: found };
}


async function reconcilePendingJobs(payload, config, statuses, priorities, calendar, source, limit) {
  const max = Number(limit || MAX_RECONCILE_JOBS);
  const snapshot = await readScheduledSnapshot();
  const cache = await readJobCache();
  const index = await readJobIndex();
  const ids = [];
  const seen = {};
  const kept = [];
  const removed = [];
  const failed = [];

  Object.keys(snapshot).forEach(add);
  Object.keys(cache).forEach(add);
  index.forEach(add);

  for (let i = 0; i < ids.length && i < max; i += 1) {
    const ticketId = String(ids[i]);
    const record = await dbGet(jobKey(ticketId), null);
    if (!record) {
      // A missing record can be a transient Freshworks datastore read miss. Do not
      // erase the durable display snapshot from a background reconcile pass.
      failed.push({ ticketId: ticketId, reason: "job_record_unavailable" });
      continue;
    }
    if (record.status !== "pending") {
      await removeJobIndex(ticketId);
      await removeJobCache(ticketId);
      await removeScheduledSnapshot(ticketId);
      continue;
    }

    let ticket = null;
    try {
      ticket = await fetchTicket(payload, ticketId);
    } catch (error) {
      failed.push({ ticketId: ticketId, reason: "fetch_failed_" + errorMessage(error) });
      continue;
    }

    const currentStatusName = statusNameById(statuses, ticket.status) || String(ticket.status || "Unknown");
    const matchingRule = matchingRuleForTicket(ticket, statuses, priorities || [], config);
    const sameRule = matchingRule && String(matchingRule.id || "") === String(record.ruleId || "");

    if (!sameRule) {
      await cancelJob(ticketId, source === "list_pending_jobs" ? "removed_from_schedule_live_status_changed" : "auto_removed_status_changed");
      removed.push({
        ticketId: ticketId,
        subject: ticket.subject || record.subject || "",
        previousTriggerStatusName: record.triggerStatusName || "-",
        currentStatusName: currentStatusName,
        reason: matchingRule ? "now_matches_different_rule" : "no_longer_matches_rule"
      });
      continue;
    }

    await addJobIndex(ticketId);
    await upsertJobCache(record, ticket, currentStatusName);
    kept.push({ ticketId: ticketId, currentStatusName: currentStatusName });
  }

  if (removed.length || failed.length) {
    await log("reconcile", source || "reconcile_pending_jobs", { kept: kept.length, removed: removed, failed: failed });
  }

  return { kept: kept, removed: removed, failed: failed };

  function add(ticketId) {
    const id = String(ticketId || "");
    if (!id || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  }
}


async function runDueJob(payload) {
  const data = payload && payload.data ? payload.data : {};
  const ticketId = data.ticketId;
  if (!ticketId) {
    console.log("RA scheduled event missing ticketId.");
    return;
  }

  try {
    const config = await loadConfig(payload);
    const record = await dbGet(jobKey(ticketId), null);
    if (!record || record.status !== "pending") {
      console.log("RA no pending job for ticket " + ticketId + ".");
      return;
    }
    if (!config.enabled) {
      await completeJob(ticketId, record, "skipped_disabled", {});
      return;
    }

    const statuses = await safeListStatuses(payload);
    const priorities = [];
    const ticket = await fetchTicket(payload, ticketId);
    const currentName = statusNameById(statuses, ticket.status) || String(ticket.status);
    if (!sameName(currentName, record.triggerStatusName)) {
      await completeJob(ticketId, record, "skipped_status_changed", { currentStatus: currentName });
      return;
    }

    const actions = [];

    if (record.changeStatus !== false) {
      const targetId = record.targetStatusId || idForName(statuses, record.targetStatusName);
      if (!targetId) throw new Error("Target status was not found in Freshdesk: " + record.targetStatusName);
      await updateTicket(payload, ticketId, { status: Number(targetId) });
      actions.push("status_updated_to_" + record.targetStatusName);
    }

    await completeJob(ticketId, record, "completed", { actions: actions });
  } catch (error) {
    console.log("RA scheduled job error: " + errorMessage(error));
    const oldRecord = await dbGet(jobKey(ticketId), null);
    if (oldRecord) await completeJob(ticketId, oldRecord, "failed", { error: errorMessage(error) });
  }
}


async function ensureStoredConfig(payload) {
  const existing = await loadStoredConfigRecord();
  if (!existing) await saveConfig(defaultConfigFromIparams(payload));
}

async function saveConfig(config) {
  const normalized = normalizeConfigPayload(config || {}, null);
  const savedAt = new Date().toISOString();
  const record = {
    config: Object.assign({}, normalized, { savedAt: savedAt, enabledText: normalized.enabled ? "true" : "false" }),
    savedAt: savedAt,
    savedAtMs: Date.parse(savedAt) || Date.now(),
    enabled: normalized.enabled,
    enabledText: normalized.enabled ? "true" : "false",
    configVersion: normalized.configVersion || "1.5.14"
  };
  await $db.set(CONFIG_KEY, record);
  try { await $db.set(CONFIG_BACKUP_KEY, record); } catch (error) { console.log("Config backup warning: " + errorMessage(error)); }
  try { await $db.set(CONFIG_TEXT_KEY, JSON.stringify(record.config)); } catch (error) { console.log("Config text backup warning: " + errorMessage(error)); }
  try { await $db.set(CONFIG_MIRROR_KEY, record); } catch (error) { console.log("Config mirror warning: " + errorMessage(error)); }
  try { await $db.set(CONFIG_MIRROR_TEXT_KEY, JSON.stringify(record.config)); } catch (error) { console.log("Config mirror text warning: " + errorMessage(error)); }
  await saveEnabledStateRecord(normalized.enabled, record.savedAtMs, savedAt);
  return Object.assign({}, normalized, { savedAt: savedAt, savedAtMs: record.savedAtMs, enabledText: normalized.enabled ? "true" : "false" });
}

async function saveEnabledStateRecord(enabled, savedAtMs, savedAt) {
  const normalizedEnabled = boolValue(enabled, false);
  const stateSavedAt = savedAt || new Date().toISOString();
  const stateSavedAtMs = Number(savedAtMs || Date.parse(stateSavedAt) || Date.now());
  const record = {
    configVersion: "1.5.14",
    enabled: normalizedEnabled,
    enabledText: normalizedEnabled ? "true" : "false",
    savedAt: stateSavedAt,
    savedAtMs: stateSavedAtMs,
    enabledStateSavedAtMs: stateSavedAtMs
  };
  await $db.set(ENABLED_STATE_KEY, record);
  try { await $db.set(ENABLED_STATE_BACKUP_KEY, record); } catch (error) { console.log("Enabled state backup warning: " + errorMessage(error)); }
  try { await $db.set(ENABLED_STATE_TEXT_KEY, JSON.stringify(record)); } catch (error) { console.log("Enabled state text backup warning: " + errorMessage(error)); }
  try { await $db.set(ENABLED_STATE_MIRROR_KEY, record); } catch (error) { console.log("Enabled state mirror warning: " + errorMessage(error)); }
  try { await $db.set(ENABLED_STATE_MIRROR_TEXT_KEY, JSON.stringify(record)); } catch (error) { console.log("Enabled state mirror text warning: " + errorMessage(error)); }
  return record;
}

async function loadEnabledStateRecord() {
  const candidates = [];
  candidates.push(unwrapEnabledState(await dbGet(ENABLED_STATE_KEY, null)));
  candidates.push(unwrapEnabledState(await dbGet(ENABLED_STATE_BACKUP_KEY, null)));
  candidates.push(unwrapEnabledState(await dbGet(ENABLED_STATE_TEXT_KEY, null)));
  candidates.push(unwrapEnabledState(await dbGet(ENABLED_STATE_MIRROR_KEY, null)));
  candidates.push(unwrapEnabledState(await dbGet(ENABLED_STATE_MIRROR_TEXT_KEY, null)));
  const valid = candidates.filter(function(item) { return item && typeof item === "object"; });
  valid.sort(function(a, b) { return configSavedTimestamp(b) - configSavedTimestamp(a); });
  return valid.length ? valid[0] : null;
}

function unwrapEnabledState(stored) {
  if (!stored) return null;
  let data = stored;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (_e) { return null; }
  }
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== "object") break;
    if (typeof data.value === "string") {
      try { data = JSON.parse(data.value); } catch (_e) { break; }
    } else if (data.value && typeof data.value === "object") data = data.value;
    else if (data.data && typeof data.data === "object") data = data.data;
    else break;
  }
  if (!data || typeof data !== "object") return null;
  if (data.enabled === undefined && data.enabledText === undefined) return null;
  const enabled = boolValue(data.enabled !== undefined ? data.enabled : data.enabledText, false);
  const savedAt = data.savedAt || undefined;
  const savedAtMs = Number(data.enabledStateSavedAtMs || data.savedAtMs || (savedAt ? Date.parse(savedAt) : 0) || 0);
  return {
    configVersion: data.configVersion || "1.5.14",
    enabled: enabled,
    enabledText: enabled ? "true" : "false",
    savedAt: savedAt,
    savedAtMs: savedAtMs,
    enabledStateSavedAtMs: savedAtMs
  };
}

async function loadStoredConfigRecord() {
  const candidates = [];
  candidates.push(unwrapStoredConfig(await dbGet(CONFIG_KEY, null)));
  candidates.push(unwrapStoredConfig(await dbGet(CONFIG_BACKUP_KEY, null)));
  candidates.push(unwrapStoredConfig(await dbGet(CONFIG_TEXT_KEY, null)));
  candidates.push(unwrapStoredConfig(await dbGet(CONFIG_MIRROR_KEY, null)));
  candidates.push(unwrapStoredConfig(await dbGet(CONFIG_MIRROR_TEXT_KEY, null)));
  const valid = candidates.filter(function(item) { return item && typeof item === "object"; });
  valid.sort(function(a, b) { return configSavedTimestamp(b) - configSavedTimestamp(a); });
  // Prefer the newest record that actually contains a saved rule. This prevents an
  // older backup where automation was enabled from resurrecting after the user saves
  // automation as disabled.
  for (let i = 0; i < valid.length; i += 1) {
    if (configHasSavedRule(valid[i])) return valid[i];
  }
  return valid.length ? valid[0] : null;
}

function configSavedTimestamp(config) {
  if (!config || typeof config !== "object") return 0;
  const candidates = [config.savedAtMs, config.savedAt, config.updatedAt, config.createdAt];
  for (let i = 0; i < candidates.length; i += 1) {
    const value = candidates[i];
    if (value === undefined || value === null || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function unwrapStoredConfig(stored) {
  if (!stored) return null;
  let data = stored;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (_e) { return null; }
  }
  // Some Freshworks runtimes wrap datastore values in a value/data object.
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== "object") break;
    if (typeof data.config === "string") {
      const meta = { savedAt: data.savedAt, savedAtMs: data.savedAtMs, enabled: data.enabled, enabledText: data.enabledText };
      try { data = Object.assign({}, JSON.parse(data.config), meta); } catch (_e) { break; }
    } else if (data.config && typeof data.config === "object") {
      const meta = { savedAt: data.savedAt, savedAtMs: data.savedAtMs, enabledText: data.enabledText };
      if (data.enabled !== undefined && data.config.enabled === undefined) meta.enabled = data.enabled;
      data = Object.assign({}, data.config, meta);
    }
    else if (typeof data.value === "string") {
      try { data = JSON.parse(data.value); } catch (_e) { break; }
    } else if (data.value && typeof data.value === "object") data = data.value;
    else if (data.data && typeof data.data === "object") data = data.data;
    else break;
  }
  if (!data || typeof data !== "object") return null;
  const hasRule = Array.isArray(data.rules) || data.triggerStatusName || data.targetStatusName || data.delayBusinessHours !== undefined;
  const hasConfig = data.configVersion || data.enabled !== undefined || hasRule;
  return hasConfig ? data : null;
}

function configHasSavedRule(config) {
  if (!config || typeof config !== "object") return false;
  let rule = null;
  if (Array.isArray(config.rules) && config.rules.length) rule = config.rules[0];
  else rule = config;
  return Boolean(rule && (cleanText(rule.triggerStatusName) || cleanText(rule.targetStatusName) || positiveNumberOrBlank(rule.delayBusinessHours)));
}

async function loadConfig(payload) {
  const stored = await loadStoredConfigRecord();
  const normalized = normalizeConfigPayload(stored || {}, defaultConfigFromIparams(payload));
  const enabledState = await loadEnabledStateRecord();
  if (enabledState && (enabledState.enabled !== undefined || enabledState.enabledText !== undefined)) {
    const enabled = boolValue(enabledState.enabled !== undefined ? enabledState.enabled : enabledState.enabledText, false);
    normalized.enabled = enabled;
    normalized.enabledText = enabled ? "true" : "false";
    normalized.enabledStateSavedAtMs = enabledState.enabledStateSavedAtMs || enabledState.savedAtMs || 0;
    if (!normalized.savedAtMs || (enabledState.savedAtMs && enabledState.savedAtMs > normalized.savedAtMs)) {
      normalized.savedAt = enabledState.savedAt || normalized.savedAt;
      normalized.savedAtMs = enabledState.savedAtMs || normalized.savedAtMs;
    }
  }
  return normalized;
}

function defaultConfigFromIparams(payload) {
  const p = iparamValues(payload);
  return normalizeConfigPayload({
    configVersion: "1.5.14",
    enabled: p.enable_automation === undefined ? false : !isNo(p.enable_automation),
    calendarMode: "freshdesk",
    businessHoursId: "",
    rules: [DEFAULT_RULE]
  }, null);
}

function normalizeConfigPayload(input, fallback) {
  const base = fallback || {
    configVersion: "1.5.14",
    enabled: false,
    calendarMode: "freshdesk",
    businessHoursId: "",
    rules: [DEFAULT_RULE]
  };
  const data = input || {};
  let sourceRule = null;
  if (Array.isArray(data.rules) && data.rules.length) sourceRule = data.rules[0];
  else sourceRule = {
    triggerStatusName: data.triggerStatusName,
    delayBusinessHours: data.delayBusinessHours,
    targetStatusName: data.targetStatusName
  };
  const fallbackRule = Array.isArray(base.rules) && base.rules.length ? base.rules[0] : DEFAULT_RULE;
  const isLegacyStoredConfig = !data.configVersion && sourceRule && Number(sourceRule.delayBusinessHours) === 72;
  if (isLegacyStoredConfig) sourceRule = Object.assign({}, sourceRule, { delayBusinessHours: "" });
  const rule = normalizeRulePayload(sourceRule, 0, fallbackRule);
  const effectiveEnabled = data.enabled !== undefined ? data.enabled : data.enabledText;
  return {
    configVersion: data.configVersion || "1.5.14",
    savedAt: data.savedAt || undefined,
    savedAtMs: data.savedAtMs || undefined,
    enabledStateSavedAtMs: Number(data.enabledStateSavedAtMs || data.savedAtMs || 0),
    enabled: boolValue(effectiveEnabled, base.enabled),
    enabledText: boolValue(effectiveEnabled, base.enabled) ? "true" : "false",
    calendarMode: "freshdesk",
    businessHoursId: "",
    customCalendar: DEFAULT_CUSTOM_CALENDAR,
    rules: [rule],
    // legacy fields kept for older scheduled records/sidebar compatibility
    triggerStatusName: rule.triggerStatusName,
    priorityName: ANY_PRIORITY,
    delayBusinessHours: rule.delayBusinessHours,
    sendPublicReply: false,
    replyBody: DEFAULT_REPLY,
    changeStatus: true,
    targetStatusName: rule.targetStatusName
  };
}

function normalizeRules(input, fallbackRules) {
  const list = Array.isArray(input) && input.length ? input : [DEFAULT_RULE];
  const fallbacks = Array.isArray(fallbackRules) && fallbackRules.length ? fallbackRules : [DEFAULT_RULE];
  const fallback = fallbacks[0] || DEFAULT_RULE;
  return [normalizeRulePayload(list[0], 0, fallback)];
}

function normalizeRulePayload(rule, index, fallbackRule) {
  const data = rule || {};
  const fallback = fallbackRule || DEFAULT_RULE;
  return {
    id: "rule_1",
    enabled: boolValue(data.enabled !== undefined ? data.enabled : data.enabledText, fallback.enabled !== false),
    enabledText: boolValue(data.enabled !== undefined ? data.enabled : data.enabledText, fallback.enabled !== false) ? "true" : "false",
    name: "Business hours automation",
    priorityOrder: 1,
    triggerStatusName: cleanText(data.triggerStatusName !== undefined ? data.triggerStatusName : fallback.triggerStatusName) || "",
    priorityName: ANY_PRIORITY,
    delayBusinessHours: positiveNumberOrBlank(data.delayBusinessHours !== undefined ? data.delayBusinessHours : fallback.delayBusinessHours),
    sendPublicReply: false,
    replyBody: DEFAULT_REPLY,
    changeStatus: true,
    targetStatusName: cleanText(data.targetStatusName !== undefined ? data.targetStatusName : fallback.targetStatusName) || ""
  };
}

function sortedActiveRules(config) {
  if (!config || config.enabled === false) return [];
  return normalizeRules(config && config.rules ? config.rules : [DEFAULT_RULE])
    .filter(function(rule) {
      return rule.enabled !== false
        && cleanText(rule.triggerStatusName)
        && cleanText(rule.targetStatusName)
        && positiveNumberOrBlank(rule.delayBusinessHours);
    });
}

function publicRule(rule) {
  const normalized = normalizeRulePayload(rule || DEFAULT_RULE, 0, DEFAULT_RULE);
  return Object.assign({}, normalized);
}

function publicConfig(config) {
  const rules = normalizeRules(config.rules || [DEFAULT_RULE]).map(publicRule);
  const first = rules[0] || publicRule(DEFAULT_RULE);
  return {
    configVersion: config.configVersion || "1.5.14",
    savedAt: config.savedAt || undefined,
    savedAtMs: config.savedAtMs || undefined,
    enabledStateSavedAtMs: Number(config.enabledStateSavedAtMs || config.savedAtMs || 0),
    enabled: boolValue(config.enabled !== undefined ? config.enabled : config.enabledText, false),
    enabledText: boolValue(config.enabled !== undefined ? config.enabled : config.enabledText, false) ? "true" : "false",
    calendarMode: "freshdesk",
    businessHoursId: "default",
    customCalendar: DEFAULT_CUSTOM_CALENDAR,
    rules: [first],
    triggerStatusName: first.triggerStatusName,
    priorityName: ANY_PRIORITY,
    delayBusinessHours: first.delayBusinessHours,
    sendPublicReply: false,
    changeStatus: true,
    targetStatusName: first.targetStatusName
  };
}

function matchingRuleForTicket(ticket, statuses, priorities, config) {
  const rules = sortedActiveRules(config || {});
  for (let i = 0; i < rules.length; i += 1) {
    if (ruleMatchesTicket(rules[i], ticket, statuses, priorities)) return rules[i];
  }
  return null;
}

function ruleMatchesTicket(rule, ticket, statuses, priorities) {
  if (!rule || !ticket || !rule.triggerStatusName) return false;
  const statusName = statusDisplayName(ticket, statuses || [], "");
  return sameName(statusName, rule.triggerStatusName);
}

function statusDisplayName(ticket, statuses, fallback) {
  const source = ticket || {};
  const statusObject = source.status && typeof source.status === "object" && !Array.isArray(source.status) ? source.status : null;
  const statusObjectId = statusObject ? (statusObject.id || statusObject.value || statusObject.status_id || statusObject.statusId) : undefined;
  const statusObjectName = statusObject ? (statusObject.name || statusObject.label || statusObject.display_name || statusObject.displayName || statusObject.value) : "";
  return cleanText(source.status_name || source.statusName || source.status_label || source.statusLabel)
    || cleanText(statusObjectName)
    || statusNameById(statuses || [], statusObjectId)
    || statusNameById(statuses || [], source.status)
    || (statusObject ? "" : cleanText(source.status))
    || fallback
    || "Unknown";
}

function isAnyPriority(value) {
  const text = cleanText(value).toLowerCase();
  return !text || text === "any priority" || text === "any" || text === "all";
}

async function listBusinessHours(payload) {
  const cached = await readCache(BUSINESS_HOURS_CACHE_KEY, BUSINESS_HOURS_CACHE_TTL_MS);
  if (cached && Array.isArray(cached.summaries)) return cached.summaries;

  try {
    const raw = await apiRequest(payload, "getBusinessHours", "GET", "/api/v2/business_hours");
    const list = Array.isArray(raw) ? raw : (raw.business_hours || raw.businessHours || []);
    const summaries = list.map(businessHourSummary).filter(function(item) { return item.id; });
    await writeCache(BUSINESS_HOURS_CACHE_KEY, { summaries: summaries, raw: list });
    return summaries;
  } catch (error) {
    const stale = await readCache(BUSINESS_HOURS_CACHE_KEY, 0, true);
    if (stale && Array.isArray(stale.summaries)) {
      console.log("RA Business Hours warning, using cached value: " + errorMessage(error));
      return stale.summaries;
    }
    throw error;
  }
}

async function getBusinessHour(payload, id) {
  const cleanId = String(id || "");
  const key = BUSINESS_HOUR_DETAIL_CACHE_PREFIX + cleanId;
  const cached = await readCache(key, BUSINESS_HOURS_CACHE_TTL_MS);
  if (cached && cached.detail) return cached.detail;

  try {
    const detail = await apiRequest(payload, "getBusinessHour", "GET", "/api/v2/business_hours/" + encodeURIComponent(cleanId), null, { businessHourId: cleanId });
    await writeCache(key, { detail: detail });
    return detail;
  } catch (error) {
    const stale = await readCache(key, 0, true);
    if (stale && stale.detail) {
      console.log("RA Business Hour detail warning, using cached value: " + errorMessage(error));
      return stale.detail;
    }
    throw error;
  }
}

async function resolveBusinessCalendar(payload, config) {
  const list = await listBusinessHours(payload);
  if (!list.length) throw new Error("Freshdesk returned no Business Hours calendars. Check the Freshdesk admin API key/domain and confirm Business Hours exist in Freshdesk.");
  let selected = list.find(function(item) { return item.isDefault; }) || list[0];
  let detailed = selected;
  try { detailed = await getBusinessHour(payload, selected.id); }
  catch (error) { console.log("RA detail Business Hours fetch warning: " + errorMessage(error)); }
  return calendarFromBusinessHour(detailed || selected);
}

function businessHourSummary(item) {
  const source = unwrapBusinessHour(item);
  const isDefault = Boolean(source.is_default || source.isDefault || source.default);
  return {
    id: source.id ? String(source.id) : "",
    name: displayBusinessHoursName(source.name || (source.id ? "Business Hours #" + source.id : "Business Hours"), isDefault, false),
    active: source.active !== false,
    isDefault: isDefault,
    timeZone: source.time_zone || source.timezone || source.timeZone || "UTC",
    rawHours: source.business_hours || source.businessHours || source.working_hours || {},
    holidays: extractHolidayDates(source)
  };
}

function unwrapBusinessHour(item) {
  const source = item || {};
  return source.business_hour || source.businessHour || source.business_hours_detail || source;
}

function displayBusinessHoursName(name, isDefault, isCustom) {
  const cleaned = cleanText(name || "");
  const lower = cleaned.toLowerCase();
  if (isCustom) return cleaned || "Custom business hours";
  if (isDefault || lower === "general working hours" || lower === "general working hours (default)") return "Freshdesk business hours";
  return cleaned || "Freshdesk business hours";
}

function calendarFromBusinessHour(item) {
  const source = unwrapBusinessHour(item);
  const raw = source.business_hours || source.businessHours || source.working_hours || source.rawHours || {};
  const days = {};
  DAY_NAMES.forEach(function(day) {
    const cfg = raw[day] || raw[capitalize(day)] || null;
    if (cfg && cfg.start_time && cfg.end_time) {
      days[day] = { enabled: true, start: normalizeClock(cfg.start_time), end: normalizeClock(cfg.end_time) };
    } else if (cfg && cfg.start && cfg.end) {
      days[day] = { enabled: true, start: normalizeClock(cfg.start), end: normalizeClock(cfg.end) };
    } else {
      days[day] = { enabled: false, start: "09:00", end: "17:00" };
    }
  });
  const isDefault = Boolean(source.is_default || source.isDefault || source.default);
  return {
    id: source.id ? String(source.id) : "",
    name: displayBusinessHoursName(source.name || "Freshdesk business hours", isDefault, false),
    isDefault: isDefault,
    timeZone: normalizeTimeZone(source.time_zone || source.timezone || source.timeZone || "UTC"),
    days: days,
    holidays: extractHolidayDates(source)
  };
}

function isCustomBusinessHoursId(value) {
  return String(value || "").trim() === CUSTOM_BUSINESS_HOURS_ID;
}

function isCustomCalendarConfig(config) {
  return Boolean(config && (config.calendarMode === "custom" || isCustomBusinessHoursId(config.businessHoursId)));
}

function normalizeCustomCalendar(input) {
  const source = input && typeof input === "object" ? input : {};
  const fallback = DEFAULT_CUSTOM_CALENDAR;
  const name = cleanText(source.name || fallback.name) || fallback.name;
  const timeZone = normalizeTimeZone(source.timeZone || source.time_zone || fallback.timeZone);
  const start = normalizeClock(source.start || fallback.start);
  const end = normalizeClock(source.end || fallback.end);
  let workingDays = source.workingDays || source.working_days || fallback.workingDays;
  if (typeof workingDays === "string") workingDays = workingDays.split(/[,\s]+/);
  if (!Array.isArray(workingDays)) workingDays = fallback.workingDays;
  workingDays = workingDays.map(function(day) { return String(day || "").trim().toLowerCase(); })
    .filter(function(day, pos, arr) { return DAY_NAMES.indexOf(day) !== -1 && arr.indexOf(day) === pos; });
  if (!workingDays.length) workingDays = fallback.workingDays.slice();
  return {
    name: name,
    timeZone: timeZone,
    workingDays: workingDays,
    start: start,
    end: end,
    holidays: normalizeHolidayList(source.holidays || source.excludedDates || source.excluded_dates || [])
  };
}

function calendarFromCustomConfig(customCalendar) {
  const cfg = normalizeCustomCalendar(customCalendar);
  const days = {};
  DAY_NAMES.forEach(function(day) {
    days[day] = { enabled: cfg.workingDays.indexOf(day) !== -1, start: cfg.start, end: cfg.end };
  });
  return {
    id: CUSTOM_BUSINESS_HOURS_ID,
    name: cfg.name || "Custom business hours",
    timeZone: cfg.timeZone,
    days: days,
    holidays: cfg.holidays || [],
    custom: true
  };
}

function businessHourSummaryFromCalendar(calendar, custom) {
  const isDefault = Boolean(calendar && calendar.isDefault);
  return {
    id: calendar && calendar.id ? String(calendar.id) : "",
    name: displayBusinessHoursName(calendar && calendar.name ? calendar.name : "Business Hours", isDefault, Boolean(custom)),
    active: true,
    isDefault: isDefault,
    isCustom: Boolean(custom),
    timeZone: calendar && calendar.timeZone ? calendar.timeZone : "UTC",
    rawHours: calendar && calendar.days ? calendar.days : {}
  };
}

async function safeListStatuses(payload) {
  try { return await listStatuses(payload); }
  catch (error) {
    console.log("RA status warning: " + errorMessage(error));
    return defaultStatuses();
  }
}

async function safeListPriorities(payload) {
  try { return await listPriorities(payload); }
  catch (error) {
    console.log("RA priority warning: " + errorMessage(error));
    return defaultPriorities();
  }
}

async function listStatuses(payload) {
  const fields = await listTicketFields(payload);
  const statuses = extractChoiceField(fields, "status");
  return statuses.length ? statuses : defaultStatuses();
}

async function listPriorities(payload) {
  const fields = await listTicketFields(payload);
  const priorities = extractChoiceField(fields, "priority");
  return priorities.length ? priorities : defaultPriorities();
}

async function listTicketFields(payload) {
  const cached = await readCache(TICKET_FIELDS_CACHE_KEY, TICKET_FIELDS_CACHE_TTL_MS);
  if (cached && Array.isArray(cached.fields)) return cached.fields;

  let fields = null;
  let firstError = null;
  try { fields = await apiRequest(payload, "getTicketFields", "GET", "/api/v2/ticket_fields"); }
  catch (error) { firstError = error; console.log("Ticket fields fetch failed. Trying admin ticket fields. " + errorMessage(error)); }
  let list = normalizeFieldsResponse(fields);
  if (list.length) {
    await writeCache(TICKET_FIELDS_CACHE_KEY, { fields: list });
    return list;
  }
  try { fields = await apiRequest(payload, "getAdminTicketFields", "GET", "/api/v2/admin/ticket_fields"); }
  catch (error) { console.log("Admin ticket fields fetch failed: " + errorMessage(error)); }
  list = normalizeFieldsResponse(fields);
  if (list.length) {
    await writeCache(TICKET_FIELDS_CACHE_KEY, { fields: list });
    return list;
  }

  const stale = await readCache(TICKET_FIELDS_CACHE_KEY, 0, true);
  if (stale && Array.isArray(stale.fields)) {
    console.log("RA ticket fields warning, using cached value: " + (firstError ? errorMessage(firstError) : "no fresh fields returned"));
    return stale.fields;
  }
  return list;
}

function normalizeFieldsResponse(fieldsResponse) {
  return Array.isArray(fieldsResponse) ? fieldsResponse : (fieldsResponse && (fieldsResponse.ticket_fields || fieldsResponse.fields || fieldsResponse.ticketFields)) || [];
}

function extractChoiceField(fieldsResponse, wanted) {
  const list = normalizeFieldsResponse(fieldsResponse);
  const field = list.find(function(item) {
    if (!item) return false;
    const name = String(item.name || "").toLowerCase();
    const label = String(item.label || "").toLowerCase();
    const type = String(item.type || "").toLowerCase();
    if (wanted === "status") return name === "status" || label === "status" || type === "default_status" || type === "status";
    if (wanted === "priority") return name === "priority" || label === "priority" || type === "default_priority" || type === "priority";
    return false;
  });
  if (!field) return [];
  return parseChoices(field.choices || field.options || field.custom_field_options || []);
}

function parseChoices(choices) {
  if (Array.isArray(choices)) {
    return choices.map(function(choice) {
      if (typeof choice === "string") return { id: null, name: choice };
      return { id: positiveNumber(choice.id || choice.value || choice.status_id || choice.priority_id, null), name: String(choice.label || choice.name || choice.value || choice.default_label || "") };
    }).filter(function(choice) { return choice.name; });
  }
  if (choices && typeof choices === "object") {
    return Object.keys(choices).map(function(key) {
      const value = choices[key];
      let name = "";
      if (Array.isArray(value)) name = String(value[0] || value[1] || key);
      else if (value && typeof value === "object") name = String(value.label || value.name || value.value || key);
      else name = String(value || key);
      return { id: positiveNumber(key, null), name: name };
    }).filter(function(choice) { return choice.name; });
  }
  return [];
}

function defaultStatuses() {
  return [
    { id: 2, name: "Open" },
    { id: 3, name: "Pending" },
    { id: 4, name: "Resolved" },
    { id: 5, name: "Closed" }
  ];
}

function defaultPriorities() {
  return [
    { id: 1, name: "Low" },
    { id: 2, name: "Medium" },
    { id: 3, name: "High" },
    { id: 4, name: "Urgent" }
  ];
}

function statusNameById(statuses, id) {
  const found = (statuses || []).find(function(item) { return item.id !== null && item.id !== undefined && String(item.id) === String(id); });
  return found ? found.name : "";
}

function priorityNameById(priorities, id) {
  const found = (priorities || []).find(function(item) { return item.id !== null && item.id !== undefined && String(item.id) === String(id); });
  return found ? found.name : "";
}

function idForName(items, name) {
  const found = (items || []).find(function(item) { return sameName(item.name, name); });
  return found && found.id !== null && found.id !== undefined ? Number(found.id) : null;
}

function idForStatusName(statuses, name) { return idForName(statuses, name); }
function sameName(a, b) { return normalizeName(a) === normalizeName(b); }
function normalizeName(value) { return String(value || "").trim().toLowerCase().replace(/\s+/g, " "); }

async function fetchTicket(payload, ticketId) {
  const raw = await apiRequest(payload, "getTicket", "GET", "/api/v2/tickets/" + encodeURIComponent(String(ticketId)), null, { ticketId: String(ticketId) });
  return unwrapTicketResponse(raw, ticketId);
}

function unwrapTicketResponse(raw, fallbackTicketId) {
  let ticket = raw || {};
  for (let i = 0; i < 4; i += 1) {
    if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) break;
    if (ticket.ticket && typeof ticket.ticket === "object") ticket = ticket.ticket;
    else if (ticket.data && ticket.data.ticket && typeof ticket.data.ticket === "object") ticket = ticket.data.ticket;
    else if (ticket.response && ticket.response.ticket && typeof ticket.response.ticket === "object") ticket = ticket.response.ticket;
    else break;
  }
  if (ticket && typeof ticket === "object" && !Array.isArray(ticket)) {
    if ((ticket.id === undefined || ticket.id === null) && fallbackTicketId) ticket.id = fallbackTicketId;
    return ticket;
  }
  return { id: fallbackTicketId };
}

async function updateTicket(payload, ticketId, body) {
  return apiRequest(payload, "updateTicket", "PUT", "/api/v2/tickets/" + encodeURIComponent(String(ticketId)), body || {}, { ticketId: String(ticketId) });
}

async function searchTicketsByStatus(payload, statusId, maxPages, maxTickets) {
  const query = encodeURIComponent('"status:' + String(statusId) + '"');
  const output = [];
  const seen = {};
  const pages = Math.max(1, Number(maxPages || 1));
  const limit = Math.max(1, Number(maxTickets || 30));

  for (let page = 1; page <= pages && output.length < limit; page += 1) {
    const raw = await apiRequest(payload, "searchTickets", "GET", "/api/v2/search/tickets?query=" + query + "&page=" + page, null, { query: query, page: String(page) });
    const results = Array.isArray(raw) ? raw : (raw.results || raw.tickets || raw.data || []);
    const pageItems = Array.isArray(results) ? results : [];
    if (!pageItems.length) break;

    for (let i = 0; i < pageItems.length && output.length < limit; i += 1) {
      const item = pageItems[i] || {};
      const id = item.id || item.ticket_id;
      if (!id || seen[String(id)]) continue;
      seen[String(id)] = true;
      output.push(item);
    }

    if (pageItems.length < 30) break;
  }

  return output;
}

async function apiRequest(payload, templateName, method, path, body, extraContext) {
  const context = Object.assign({ host: hostName(payload) }, extraContext || {});
  const options = { context: context };
  if (body !== undefined && body !== null) options.body = JSON.stringify(body);

  if (typeof $request === "undefined" || !$request || typeof $request.invokeTemplate !== "function") {
    throw new Error("Freshworks request method is unavailable in this runtime. Install the app in Freshdesk and do not run this page standalone.");
  }

  try {
    const result = await $request.invokeTemplate(templateName, options);
    if (result && result.status && Number(result.status) >= 400) {
      throw new Error(templateName + " returned HTTP " + result.status + ": " + String(result.response || "").slice(0, 700));
    }
    return parseApiResponse(result);
  } catch (templateError) {
    throw new Error(templateName + " request-template failed for https://" + context.host + path + ": " + errorMessage(templateError));
  }
}

function parseApiResponse(result) {
  if (!result || result.response === undefined || result.response === null) return {};
  if (typeof result.response === "string") return result.response ? JSON.parse(result.response) : {};
  return result.response;
}

function addBusinessMinutes(startIso, minutes, calendar) {
  let remaining = Math.max(0, Math.round(Number(minutes || 0)));
  let cursor = new Date(startIso);
  if (Number.isNaN(cursor.getTime())) throw new Error("Invalid start time.");
  if (!remaining) return cursor.toISOString();

  let key = localDateKey(cursor, calendar.timeZone);
  for (let guard = 0; guard < 5000; guard += 1) {
    const win = windowForDate(key, calendar);
    if (win && cursor < win.end) {
      const start = cursor > win.start ? cursor : win.start;
      if (start < win.end) {
        const available = Math.floor((win.end.getTime() - start.getTime()) / 60000);
        if (remaining <= available) return new Date(start.getTime() + remaining * 60000).toISOString();
        remaining -= available;
        cursor = win.end;
      }
    }
    key = addDays(key, 1);
    const next = zonedToUtc(key, "00:00", calendar.timeZone);
    if (cursor < next) cursor = next;
  }
  throw new Error("Unable to calculate due date from business hours.");
}

function windowForDate(dateKey, calendar) {
  const cfg = calendar.days[weekday(dateKey)];
  if (!cfg || !cfg.enabled || calendar.holidays.indexOf(dateKey) !== -1) return null;
  const start = zonedToUtc(dateKey, cfg.start, calendar.timeZone);
  const endDateKey = clockSeconds(cfg.end) <= clockSeconds(cfg.start) ? addDays(dateKey, 1) : dateKey;
  const end = zonedToUtc(endDateKey, cfg.end, calendar.timeZone);
  if (end <= start) return null;
  return { start: start, end: end };
}

function zonedToUtc(dateKey, time, timeZone) {
  const d = parseDate(dateKey);
  const c = parseClock(time);
  const targetLocal = Date.UTC(d.year, d.month - 1, d.day, c.hour, c.minute, c.second);
  let utc = new Date(targetLocal);
  for (let i = 0; i < 4; i += 1) {
    const parts = localParts(utc, timeZone);
    const actualLocal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const delta = targetLocal - actualLocal;
    utc = new Date(utc.getTime() + delta);
    if (Math.abs(delta) < 1000) break;
  }
  return utc;
}

function localParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone,
    hourCycle: "h23",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const obj = {};
  formatter.formatToParts(date).forEach(function(part) { if (part.type !== "literal") obj[part.type] = part.value; });
  return {
    year: Number(obj.year),
    month: Number(obj.month),
    day: Number(obj.day),
    hour: Number(obj.hour),
    minute: Number(obj.minute),
    second: Number(obj.second),
    weekday: String(obj.weekday || "").toLowerCase()
  };
}

function localDateKey(date, timeZone) {
  const p = localParts(date, timeZone);
  return p.year + "-" + pad(p.month) + "-" + pad(p.day);
}

function weekday(dateKey) {
  const p = parseDate(dateKey);
  return DAY_NAMES[new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).getUTCDay()];
}

function addDays(dateKey, days) {
  const p = parseDate(dateKey);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + Number(days || 0), 12));
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

function parseDate(dateKey) {
  const m = String(dateKey).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error("Invalid date: " + dateKey);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function normalizeTimeZone(value) {
  const raw = String(value || "UTC").trim();
  const tz = TZ_MAP[raw] || raw;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date()); return tz; }
  catch (_e) { return "UTC"; }
}

function normalizeClock(value) {
  const c = parseClock(value);
  return pad(c.hour) + ":" + pad(c.minute);
}

function parseClock(value) {
  const m = String(value || "00:00").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*(am|pm)?$/);
  if (!m) throw new Error("Invalid clock: " + value);
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const second = Number(m[3] || 0);
  const meridiem = m[4];
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 24 || minute > 59 || second > 59 || (hour === 24 && (minute || second))) throw new Error("Invalid clock: " + value);
  return { hour: hour, minute: minute, second: second };
}

function clockSeconds(value) {
  const c = parseClock(value);
  return c.hour * 3600 + c.minute * 60 + c.second;
}

function normalizeHolidayList(list) {
  const output = [];
  const seen = {};
  const items = Array.isArray(list) ? list : (list ? [list] : []);
  items.forEach(function(item) {
    extractDatesFromHolidayValue(item).forEach(add);
  });
  return output;

  function add(value) {
    const date = String(value || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !seen[date]) {
      seen[date] = true;
      output.push(date);
    }
  }
}

function extractHolidayDates(source) {
  const output = [];
  const seen = {};
  const root = source || {};
  [
    root.holidays,
    root.holiday,
    root.holiday_list,
    root.holidayList,
    root.holiday_dates,
    root.holidayDates,
    root.excluded_dates,
    root.excludedDates,
    root.closed_dates,
    root.closedDates,
    root.exceptions,
    root.business_hour_holidays,
    root.businessHourHolidays
  ].forEach(function(value) {
    extractDatesFromHolidayValue(value).forEach(add);
  });

  // Some Freshdesk accounts return holiday data nested inside the detailed Business Hours object.
  // Search only holiday/excluded/closed/exception-shaped properties to avoid treating ordinary timestamps as holidays.
  scanHolidayProperties(root, 0);
  return output;

  function add(value) {
    const date = String(value || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !seen[date]) {
      seen[date] = true;
      output.push(date);
    }
  }

  function scanHolidayProperties(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > 3) return;
    Object.keys(obj).forEach(function(key) {
      const lower = String(key).toLowerCase();
      const value = obj[key];
      if (/(holiday|excluded|closed|exception)/.test(lower)) {
        extractDatesFromHolidayValue(value).forEach(add);
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        scanHolidayProperties(value, depth + 1);
      }
    });
  }
}

function extractDatesFromHolidayValue(value) {
  const dates = [];
  if (!value) return dates;
  if (typeof value === "string") {
    const match = value.match(/\d{4}-\d{2}-\d{2}/g);
    return match || [];
  }
  if (Array.isArray(value)) {
    value.forEach(function(item) {
      extractDatesFromHolidayValue(item).forEach(function(date) { dates.push(date); });
    });
    return dates;
  }
  if (typeof value === "object") {
    ["date", "holiday_date", "holidayDate", "start_date", "startDate", "closed_date", "closedDate"].forEach(function(key) {
      if (value[key]) extractDatesFromHolidayValue(value[key]).forEach(function(date) { dates.push(date); });
    });
  }
  return dates;
}



async function findJobForTicket(ticketId, ticket) {
  const candidates = ticketIdCandidates(ticketId, ticket);
  for (let i = 0; i < candidates.length; i += 1) {
    const record = await dbGet(jobKey(candidates[i]), null);
    if (record && record.status === "pending") return Object.assign({}, record, { ticketId: String(record.ticketId || candidates[i]) });
  }

  const cache = await readJobCache();
  for (let j = 0; j < candidates.length; j += 1) {
    const cached = cache[String(candidates[j])];
    if (cached && cached.status === "pending") return jobRecordFromSummary(cached);
  }

  // Last-resort numeric comparison. Freshdesk sometimes exposes both id and display_id.
  const numericCandidates = candidates.map(onlyDigits).filter(Boolean);
  const cacheKeys = Object.keys(cache || {});
  for (let k = 0; k < cacheKeys.length; k += 1) {
    const key = cacheKeys[k];
    if (numericCandidates.indexOf(onlyDigits(key)) !== -1 && cache[key] && cache[key].status === "pending") {
      return jobRecordFromSummary(cache[key]);
    }
  }

  return null;
}

function findJobSummaryForTicket(items, ticketId, ticket) {
  const candidates = ticketIdCandidates(ticketId, ticket);
  const numericCandidates = candidates.map(onlyDigits).filter(Boolean);
  for (let i = 0; i < (items || []).length; i += 1) {
    const item = items[i] || {};
    const id = String(item.ticketId || item.id || item.ticket_id || "");
    if (!id) continue;
    if (candidates.indexOf(id) !== -1 || numericCandidates.indexOf(onlyDigits(id)) !== -1) {
      return jobRecordFromSummary(item);
    }
  }
  return null;
}

function ticketIdCandidates(ticketId, ticket) {
  const raw = [];
  if (ticketId !== undefined && ticketId !== null) raw.push(ticketId);
  const t = ticket || {};
  raw.push(t.id, t.ticket_id, t.ticketId, t.display_id, t.displayId, t.display_ticket_id);
  const out = [];
  const seen = {};
  raw.forEach(function(value) {
    if (value === undefined || value === null) return;
    const id = String(value).trim();
    if (!id || seen[id]) return;
    seen[id] = true;
    out.push(id);
  });
  return out;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D+/g, "");
}

function jobRecordFromSummary(summary) {
  const item = summary || {};
  return {
    status: item.status || "pending",
    ticketId: String(item.ticketId || item.id || item.ticket_id || ""),
    dueAt: item.dueAt || item.due_at || "",
    createdAt: item.createdAt || item.created_at || "",
    ruleId: item.ruleId || "rule_1",
    ruleName: item.ruleName || "Automation rule",
    triggerStatusName: item.triggerStatusName || "-",
    targetStatusName: item.targetStatusName || "-",
    businessHoursName: item.businessHoursName || "Freshdesk business hours",
    delayBusinessHours: item.delayBusinessHours || ""
  };
}


async function upsertOneTimeSchedule(name, data, dueAt) {
  const payload = { name: name, data: data || {}, schedule_at: dueAt };
  // One-time ticket schedules reuse the same name when a ticket enters the trigger
  // status again. Delete first so an old fired/stale schedule cannot block the new run.
  try { await $schedule.delete({ name: name }); } catch (_deleteError) {}
  try {
    await $schedule.create(payload);
    return;
  } catch (createError) {
    console.log("RA one-time schedule create warning for " + name + ": " + errorMessage(createError) + ". Trying update.");
    try {
      await $schedule.update(payload);
      return;
    } catch (updateError) {
      console.log("RA one-time schedule update warning for " + name + ": " + errorMessage(updateError) + ". Recreating after delete.");
      try { await $schedule.delete({ name: name }); } catch (_deleteAgainError) {}
      await $schedule.create(payload);
    }
  }
}

async function upsertSchedule(name, data, dueAt, repeat) {
  const payload = { name: name, data: data || {}, schedule_at: dueAt };
  if (repeat) payload.repeat = repeat;

  // Freshworks schedules can occasionally fail to update if the existing schedule
  // is stale or was created by an older app version. In that case, delete and
  // recreate the schedule so autoscan/status-change fallback does not silently die.
  let exists = false;
  try {
    await $schedule.fetch({ name: name });
    exists = true;
  } catch (_fetchError) {
    exists = false;
  }

  if (exists) {
    try {
      await $schedule.update(payload);
      return;
    } catch (updateError) {
      console.log("RA schedule update warning for " + name + ": " + errorMessage(updateError) + ". Recreating schedule.");
      try { await $schedule.delete({ name: name }); } catch (_deleteError) {}
    }
  }

  try {
    await $schedule.create(payload);
  } catch (createError) {
    console.log("RA schedule create warning for " + name + ": " + errorMessage(createError));
    try {
      await $schedule.update(payload);
    } catch (secondError) {
      throw secondError;
    }
  }
}

async function cancelJob(ticketId, reason) {
  const key = jobKey(ticketId);
  const record = await dbGet(key, null);
  if (!record || record.status !== "pending") {
    try { await $schedule.delete({ name: scheduleName(ticketId) }); } catch (_e) {}
    await removeJobIndex(ticketId);
    await removeJobCache(ticketId);
    await removeScheduledSnapshot(ticketId);
    return;
  }
  try { await $schedule.delete({ name: scheduleName(ticketId) }); } catch (_e) {}
  await completeJob(ticketId, record, reason || "cancelled", {});
}

async function cancelAllPendingJobs(reason) {
  const snapshot = await readScheduledSnapshot();
  const cache = await readJobCache();
  let index = await readJobIndex();
  const ids = [];
  const seen = {};
  Object.keys(snapshot).forEach(add);
  Object.keys(cache).forEach(add);
  index.forEach(add);

  let cancelled = 0;
  const skipped = [];
  for (let i = 0; i < ids.length; i += 1) {
    const ticketId = ids[i];
    const record = await dbGet(jobKey(ticketId), null);
    if (!record || record.status !== "pending") {
      await removeJobIndex(ticketId);
      await removeJobCache(ticketId);
      await removeScheduledSnapshot(ticketId);
      skipped.push({ ticketId: ticketId, reason: "not_active" });
      continue;
    }
    try {
      await cancelJob(ticketId, reason || "cancelled_all");
      cancelled += 1;
    } catch (error) {
      skipped.push({ ticketId: ticketId, reason: errorMessage(error) });
    }
  }

  // Do not force-write an empty array/object back to Freshworks data storage here.
  // Some Freshworks runtimes reject empty values with "Mandatory attributes (key or value) is missing".
  // cancelJob(), removeJobIndex(), and removeJobCache() already clean each ticket safely.
  await log("all", "cancelled_all", { cancelled: cancelled, skipped: skipped.length });
  return { cancelled: cancelled, skipped: skipped };

  function add(ticketId) {
    const id = String(ticketId || "");
    if (!id || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  }
}

async function completeJob(ticketId, record, status, extra) {
  const updated = Object.assign({}, record, extra || {}, { status: status, completedAt: new Date().toISOString() });
  await $db.set(jobKey(ticketId), updated);
  await removeJobIndex(ticketId);
  await removeJobCache(ticketId);
  await removeScheduledSnapshot(ticketId);
  await log(ticketId, status, updated);
}

async function markJobInactive(ticketId, record, status, extra) {
  const updated = Object.assign({}, record, extra || {}, { status: status || "inactive", inactiveAt: new Date().toISOString() });
  await $db.set(jobKey(ticketId), updated);
  await removeJobIndex(ticketId);
  await removeJobCache(ticketId);
  await removeScheduledSnapshot(ticketId);
  await log(ticketId, status || "inactive", updated);
}

async function addJobIndex(ticketId) {
  const id = String(ticketId || "");
  if (!id) return;
  let list = await readJobIndex();
  list = list.map(String).filter(function(item, pos, arr) { return item && arr.indexOf(item) === pos && item !== id; });
  list.unshift(id);
  if (list.length > 500) list = list.slice(0, 500);
  await writeJobIndex(list);
}
async function removeJobIndex(ticketId) {
  const id = String(ticketId || "");
  let list = await readJobIndex();
  list = list.map(String).filter(function(item) { return item && item !== id; });
  await writeJobIndex(list);
}

async function readJobIndex() {
  // Prefer the text mirror because Freshworks data storage can reject empty arrays.
  // If the primary index failed to clear, the text mirror still represents the latest state.
  const textWrapped = await dbGet(JOB_INDEX_TEXT_KEY, null);
  try {
    const text = textWrapped && typeof textWrapped === "object" && textWrapped.text !== undefined ? textWrapped.text : textWrapped;
    const parsed = typeof text === "string" ? JSON.parse(text) : text;
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch (_e) {}
  const list = await dbGet(JOB_INDEX_KEY, []);
  return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
}

async function writeJobIndex(list) {
  const normalized = Array.isArray(list) ? list.map(String).filter(Boolean) : [];
  try { await $db.set(JOB_INDEX_KEY, normalized); } catch (error) { console.log("RA job index write warning: " + errorMessage(error)); }
  try { await $db.set(JOB_INDEX_TEXT_KEY, { text: JSON.stringify(normalized), updatedAt: new Date().toISOString() }); } catch (error) { console.log("RA job index text write warning: " + errorMessage(error)); }
}
async function listPendingJobs(payload, statuses, limit, configOverride, options) {
  const max = Number(limit || 20);
  const effectiveStatuses = statuses || await safeListStatuses(payload);
  const effectiveConfig = configOverride || await loadConfig(payload);
  const opts = options || {};
  const liveValidationLimit = Math.max(0, Number(opts.liveValidationLimit !== undefined ? opts.liveValidationLimit : 0));
  const priorities = [];
  const mergedIds = [];
  const seen = {};
  const output = [];
  const snapshot = await readScheduledSnapshot();
  const cache = await readJobCache();
  const index = await readJobIndex();
  let liveChecks = 0;

  // Merge the durable display snapshot first, then cache and index. The snapshot is
  // intentionally separate from the job/index stores so the visible list survives
  // temporary Freshworks datastore read misses while switching app locations.
  Object.keys(snapshot).forEach(function(ticketId) { addMerged(ticketId); });
  Object.keys(cache).forEach(function(ticketId) { addMerged(ticketId); });
  index.forEach(function(ticketId) { addMerged(ticketId); });

  for (let i = 0; i < mergedIds.length && output.length < max; i += 1) {
    const ticketId = String(mergedIds[i]);
    const cached = cache[ticketId] || snapshot[ticketId] || {};
    const record = await dbGet(jobKey(ticketId), null);

    if (record && record.status === "pending") {
      let liveTicket = null;
      let currentStatusName = cached.currentStatusName || record.triggerStatusName || "Unknown";
      let subject = cached.subject || record.subject || "";
      let liveValidated = false;

      if (liveChecks < liveValidationLimit) {
        liveChecks += 1;
        try {
          liveTicket = await fetchTicket(payload, ticketId);
          liveValidated = true;
          currentStatusName = statusNameById(effectiveStatuses, liveTicket.status) || String(liveTicket.status || "Unknown");
          subject = liveTicket.subject || subject;
          const matchingRule = matchingRuleForTicket(liveTicket, effectiveStatuses, priorities, effectiveConfig);
          const sameRule = matchingRule && String(matchingRule.id || "") === String(record.ruleId || "");
          if (!sameRule) {
            await cancelJob(ticketId, "removed_from_schedule_live_status_changed");
            continue;
          }
          await upsertJobCache(record, liveTicket, currentStatusName);
          await upsertScheduledSnapshot(record, liveTicket, currentStatusName);
        } catch (error) {
          console.log("RA live status refresh skipped for ticket " + ticketId + ": " + errorMessage(error));
        }
      }

      output.push({
        ticketId: ticketId,
        status: record.status,
        dueAt: record.dueAt,
        createdAt: record.createdAt,
        ruleId: record.ruleId || "rule_1",
        ruleName: record.ruleName || "Automation rule",
        triggerStatusName: record.triggerStatusName || cached.triggerStatusName || "-",
        priorityName: record.priorityName || ANY_PRIORITY,
        targetStatusName: record.targetStatusName || cached.targetStatusName || "-",
        businessHoursName: record.businessHoursName || cached.businessHoursName || "Freshdesk business hours",
        delayBusinessHours: record.delayBusinessHours || cached.delayBusinessHours || "",
        subject: subject,
        currentStatusName: currentStatusName,
        liveValidated: liveValidated
      });
      continue;
    }

    // Cache-only rows are a display fallback for Freshworks datastore eventual consistency.
    // They keep the list visible immediately after save/scan, while auto-scan and due-job
    // validation still prevent stale tickets from executing.
    if ((!record || record.status === undefined) && cached && cached.status === "pending" && cached.dueAt) {
      let currentStatusName = cached.currentStatusName || cached.triggerStatusName || "Unknown";
      let liveValidated = false;
      if (liveChecks < liveValidationLimit) {
        liveChecks += 1;
        try {
          const liveTicket = await fetchTicket(payload, ticketId);
          liveValidated = true;
          currentStatusName = statusNameById(effectiveStatuses, liveTicket.status) || String(liveTicket.status || "Unknown");
          const matchingRule = matchingRuleForTicket(liveTicket, effectiveStatuses, priorities, effectiveConfig);
          const sameRule = matchingRule && String(matchingRule.id || "") === String(cached.ruleId || "");
          if (!sameRule) {
            await removeJobIndex(ticketId);
            await removeJobCache(ticketId);
            await removeScheduledSnapshot(ticketId);
            try { await $schedule.delete({ name: scheduleName(ticketId) }); } catch (_e) {}
            continue;
          }
        } catch (error) {
          console.log("RA cache-only live status refresh skipped for ticket " + ticketId + ": " + errorMessage(error));
        }
      }
      output.push({
        ticketId: ticketId,
        status: cached.status,
        dueAt: cached.dueAt,
        createdAt: cached.createdAt,
        ruleId: cached.ruleId || "rule_1",
        ruleName: cached.ruleName || "Automation rule",
        triggerStatusName: cached.triggerStatusName || "-",
        priorityName: cached.priorityName || ANY_PRIORITY,
        targetStatusName: cached.targetStatusName || "-",
        businessHoursName: cached.businessHoursName || "Freshdesk business hours",
        delayBusinessHours: cached.delayBusinessHours || "",
        subject: cached.subject || "",
        currentStatusName: currentStatusName,
        cacheOnly: true,
        liveValidated: liveValidated
      });
      continue;
    }

    if (record && record.status !== "pending") {
      await removeJobIndex(ticketId);
      await removeJobCache(ticketId);
      await removeScheduledSnapshot(ticketId);
    } else if (!record && liveValidationLimit > 0) {
      // Only clean unresolved rows during explicit live validation. The display path
      // must not erase the visible list on a transient Freshworks datastore read miss.
      await removeJobIndex(ticketId);
      await removeJobCache(ticketId);
    }
  }

  output.sort(function(a, b) {
    return new Date(a.dueAt || 0).getTime() - new Date(b.dueAt || 0).getTime();
  });

  return output;

  function addMerged(ticketId) {
    const id = String(ticketId || "");
    if (!id || seen[id]) return;
    seen[id] = true;
    mergedIds.push(id);
  }
}


async function readScheduledSnapshot() {
  const primary = normalizeScheduledSnapshot(await dbGet(JOB_SNAPSHOT_KEY, {}));
  const text = normalizeScheduledSnapshot(await readJsonMirror(JOB_SNAPSHOT_TEXT_KEY, {}));
  const merged = mergeScheduledSnapshotMaps(primary, text);
  const tombstones = await readScheduledSnapshotTombstones();

  Object.keys(tombstones).forEach(function(ticketId) {
    const row = merged[ticketId];
    const deletedAt = Date.parse(tombstones[ticketId] || "") || 0;
    const rowUpdatedAt = Date.parse(row && row.updatedAt ? row.updatedAt : "") || 0;
    if (!row || !rowUpdatedAt || deletedAt >= rowUpdatedAt) delete merged[ticketId];
  });

  return merged;
}

function normalizeScheduledSnapshot(snapshot) {
  const out = {};
  Object.keys(snapshot || {}).forEach(function(key) {
    const item = snapshot[key] || {};
    const ticketId = String(item.ticketId || key || "");
    if (!ticketId || item.status !== "pending" || !item.dueAt) return;
    out[ticketId] = Object.assign({}, item, { ticketId: ticketId, status: "pending" });
  });
  return out;
}

function mergeScheduledSnapshotMaps() {
  const out = {};
  for (let i = 0; i < arguments.length; i += 1) {
    const map = normalizeScheduledSnapshot(arguments[i] || {});
    Object.keys(map).forEach(function(ticketId) {
      const next = map[ticketId];
      const existing = out[ticketId];
      const nextUpdated = Date.parse(next.updatedAt || next.createdAt || "") || 0;
      const existingUpdated = Date.parse(existing && (existing.updatedAt || existing.createdAt) || "") || 0;
      if (!existing || nextUpdated >= existingUpdated) out[ticketId] = next;
    });
  }
  return out;
}

async function readScheduledSnapshotTombstones() {
  const primary = await dbGet(JOB_SNAPSHOT_TOMBSTONE_KEY, {});
  const text = await readJsonMirror(JOB_SNAPSHOT_TOMBSTONE_TEXT_KEY, {});
  const merged = {};
  [primary, text].forEach(function(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return;
    Object.keys(source).forEach(function(key) {
      const ticketId = String(key || "");
      const deletedAt = typeof source[key] === "string" ? source[key] : (source[key] && source[key].deletedAt);
      if (!ticketId || !deletedAt) return;
      const existing = Date.parse(merged[ticketId] || "") || 0;
      const next = Date.parse(deletedAt || "") || 0;
      if (next >= existing) merged[ticketId] = deletedAt;
    });
  });
  return merged;
}

async function writeScheduledSnapshotTombstones(tombstones) {
  const safe = {};
  Object.keys(tombstones || {}).forEach(function(key) {
    const ticketId = String(key || "");
    const deletedAt = typeof tombstones[key] === "string" ? tombstones[key] : (tombstones[key] && tombstones[key].deletedAt);
    if (ticketId && deletedAt) safe[ticketId] = deletedAt;
  });
  const ids = Object.keys(safe).sort(function(a, b) { return String(safe[b] || "").localeCompare(String(safe[a] || "")); });
  while (ids.length > 1000) {
    const removeId = ids.pop();
    delete safe[removeId];
  }
  try { await $db.set(JOB_SNAPSHOT_TOMBSTONE_KEY, safe); } catch (error) { console.log("RA scheduled snapshot tombstone write warning: " + errorMessage(error)); }
  try { await $db.set(JOB_SNAPSHOT_TOMBSTONE_TEXT_KEY, { text: JSON.stringify(safe), updatedAt: new Date().toISOString() }); } catch (error) { console.log("RA scheduled snapshot tombstone text write warning: " + errorMessage(error)); }
}

async function writeScheduledSnapshot(snapshot, options) {
  const opts = options || {};
  const incoming = normalizeScheduledSnapshot(snapshot || {});
  const incomingIds = Object.keys(incoming);
  const removeIds = (opts.removeIds || []).map(function(value) { return String(value || ""); }).filter(Boolean);
  let safe = opts.replace === true ? incoming : mergeScheduledSnapshotMaps(await readScheduledSnapshot(), incoming);

  if (incomingIds.length) {
    const tombstones = await readScheduledSnapshotTombstones();
    let changed = false;
    incomingIds.forEach(function(ticketId) {
      if (tombstones[ticketId]) {
        delete tombstones[ticketId];
        changed = true;
      }
    });
    if (changed) await writeScheduledSnapshotTombstones(tombstones);
  }

  if (removeIds.length) {
    const tombstones = await readScheduledSnapshotTombstones();
    const now = new Date().toISOString();
    removeIds.forEach(function(ticketId) {
      delete safe[ticketId];
      tombstones[ticketId] = now;
    });
    await writeScheduledSnapshotTombstones(tombstones);
  }

  const ids = Object.keys(safe).sort(function(a, b) {
    return String(safe[b].updatedAt || safe[b].createdAt || "").localeCompare(String(safe[a].updatedAt || safe[a].createdAt || ""));
  });
  while (ids.length > 500) {
    const removeId = ids.pop();
    delete safe[removeId];
  }
  try { await $db.set(JOB_SNAPSHOT_KEY, safe); } catch (error) { console.log("RA scheduled snapshot write warning: " + errorMessage(error)); }
  try { await $db.set(JOB_SNAPSHOT_TEXT_KEY, { text: JSON.stringify(safe), updatedAt: new Date().toISOString() }); } catch (error) { console.log("RA scheduled snapshot text write warning: " + errorMessage(error)); }
}

async function upsertScheduledSnapshot(record, ticket, currentStatusName) {
  const ticketId = String(record.ticketId || (ticket && (ticket.id || ticket.ticket_id)) || "");
  if (!ticketId) return;
  const row = {
    ticketId: ticketId,
    status: "pending",
    dueAt: record.dueAt,
    createdAt: record.createdAt,
    ruleId: record.ruleId || "rule_1",
    ruleName: record.ruleName || "Automation rule",
    triggerStatusName: record.triggerStatusName,
    priorityName: record.priorityName || ANY_PRIORITY,
    targetStatusName: record.targetStatusName,
    businessHoursName: record.businessHoursName || "Freshdesk business hours",
    delayBusinessHours: record.delayBusinessHours || "",
    subject: ticket && ticket.subject ? String(ticket.subject) : (record.subject || ""),
    currentStatusName: currentStatusName || record.triggerStatusName || "Unknown",
    updatedAt: new Date().toISOString(),
    snapshotSource: "server_schedule_snapshot"
  };
  const wrapper = {};
  wrapper[ticketId] = row;
  await writeScheduledSnapshot(wrapper);
}

async function removeScheduledSnapshot(ticketId) {
  const id = String(ticketId || "");
  if (!id) return;
  await writeScheduledSnapshot({}, { removeIds: [id] });
}

async function readJsonMirror(key, fallback) {
  const wrapped = await dbGet(key, null);
  try {
    const text = wrapped && typeof wrapped === "object" && wrapped.text !== undefined ? wrapped.text : wrapped;
    const parsed = typeof text === "string" ? JSON.parse(text) : text;
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch (_e) {
    return fallback;
  }
}

async function readJobCache() {
  // Freshworks data storage can reject empty objects, leaving a stale primary cache.
  // Use the text mirror when it is newer, but fall back to primary if a newer schedule
  // was written there and the mirror write failed.
  const cache = await dbGet(JOB_CACHE_KEY, {});
  const primary = cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
  const primaryTs = latestCacheTimestamp(primary);
  const textWrapped = await dbGet(JOB_CACHE_TEXT_KEY, null);
  try {
    const text = textWrapped && typeof textWrapped === "object" && textWrapped.text !== undefined ? textWrapped.text : textWrapped;
    const textTs = textWrapped && typeof textWrapped === "object" && textWrapped.updatedAt ? Date.parse(textWrapped.updatedAt) || 0 : 0;
    const parsed = typeof text === "string" ? JSON.parse(text) : text;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (!Object.keys(primary).length || textTs >= primaryTs) return parsed;
    }
  } catch (_e) {}
  return primary;
}

function latestCacheTimestamp(cache) {
  let latest = 0;
  Object.keys(cache || {}).forEach(function(key) {
    const ts = Date.parse(cache[key] && cache[key].updatedAt ? cache[key].updatedAt : "") || 0;
    if (ts > latest) latest = ts;
  });
  return latest;
}

async function writeJobCache(cache) {
  const safe = cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
  try { await $db.set(JOB_CACHE_KEY, safe); } catch (error) { console.log("RA job cache write warning: " + errorMessage(error)); }
  try { await $db.set(JOB_CACHE_TEXT_KEY, { text: JSON.stringify(safe), updatedAt: new Date().toISOString() }); } catch (error) { console.log("RA job cache text write warning: " + errorMessage(error)); }
}

async function upsertJobCache(record, ticket, currentStatusName) {
  const cache = await readJobCache();
  const ticketId = String(record.ticketId || (ticket && (ticket.id || ticket.ticket_id)) || "");
  if (!ticketId) return;
  cache[ticketId] = {
    ticketId: ticketId,
    status: record.status,
    dueAt: record.dueAt,
    createdAt: record.createdAt,
    ruleId: record.ruleId || "rule_1",
    ruleName: record.ruleName || "Automation rule",
    triggerStatusName: record.triggerStatusName,
    priorityName: record.priorityName || ANY_PRIORITY,
    targetStatusName: record.targetStatusName,
    businessHoursName: record.businessHoursName,
    delayBusinessHours: record.delayBusinessHours,
    subject: ticket && ticket.subject ? String(ticket.subject) : "",
    currentStatusName: currentStatusName || record.triggerStatusName || "Unknown",
    updatedAt: new Date().toISOString()
  };
  const ids = Object.keys(cache).sort(function(a, b) {
    return String(cache[b].updatedAt || "").localeCompare(String(cache[a].updatedAt || ""));
  });
  while (ids.length > 300) {
    const removeId = ids.pop();
    delete cache[removeId];
  }
  await writeJobCache(cache);
}

async function removeJobCache(ticketId) {
  const cache = await readJobCache();
  const id = String(ticketId);
  if (cache[id]) {
    delete cache[id];
    await writeJobCache(cache);
  }
}

function buildAffectedTicketsFromScan(scheduled, alreadyScheduled) {
  const out = [];
  const seen = {};
  function add(item) {
    const ticketId = String(item && item.ticketId || "");
    if (!ticketId || seen[ticketId]) return;
    seen[ticketId] = true;
    out.push({
      ticketId: ticketId,
      status: "pending",
      dueAt: item.dueAt || "",
      createdAt: item.createdAt || new Date().toISOString(),
      ruleId: item.ruleId || "rule_1",
      ruleName: item.ruleName || "Automation rule",
      triggerStatusName: item.triggerStatusName || "-",
      priorityName: item.priorityName || ANY_PRIORITY,
      targetStatusName: item.targetStatusName || "-",
      businessHoursName: item.businessHoursName || "Freshdesk business hours",
      delayBusinessHours: item.delayBusinessHours || "",
      subject: item.subject || "",
      currentStatusName: item.currentStatusName || item.triggerStatusName || "Unknown",
      scanSnapshot: true
    });
  }
  (scheduled || []).forEach(add);
  (alreadyScheduled || []).forEach(add);
  out.sort(function(a, b) {
    return new Date(a.dueAt || 0).getTime() - new Date(b.dueAt || 0).getTime();
  });
  return out;
}


function selectBusinessHourSummary(items, configuredId) {
  if (isCustomBusinessHoursId(configuredId)) return businessHourSummaryFromCalendar(calendarFromCustomConfig(DEFAULT_CUSTOM_CALENDAR), true);
  const list = items || [];
  if (configuredId) {
    const selected = list.find(function(item) { return String(item.id) === String(configuredId); });
    if (selected) return selected;
  }
  return list.find(function(item) { return item.isDefault; }) || list[0] || null;
}

function ticketSummary(ticket, statuses, priorities) {
  const raw = ticket || {};
  return {
    id: raw.id ? String(raw.id) : "",
    subject: raw.subject || "",
    status: raw.status,
    statusName: statusNameById(statuses || [], raw.status) || String(raw.status || "Unknown"),
    priority: raw.priority,
    priorityName: priorityNameById(priorities || [], raw.priority) || String(raw.priority || ""),
    requesterId: raw.requester_id || raw.requesterId || null,
    updatedAt: raw.updated_at || raw.updatedAt || "",
    createdAt: raw.created_at || raw.createdAt || ""
  };
}

async function readCache(key, ttlMs, allowStale) {
  const wrapped = await dbGet(key, null);
  if (!wrapped || typeof wrapped !== "object" || wrapped.value === undefined) return null;
  const savedAt = new Date(wrapped.savedAt || 0).getTime();
  if (!allowStale && ttlMs > 0 && (!savedAt || Date.now() - savedAt > ttlMs)) return null;
  return wrapped.value;
}

async function writeCache(key, value) {
  try { await $db.set(key, { savedAt: new Date().toISOString(), value: value }); }
  catch (error) { console.log("RA cache write warning for " + key + ": " + errorMessage(error)); }
}

async function dbGet(key, fallback) {
  try { return await $db.get(key); }
  catch (_error) { return fallback; }
}

async function log(subject, event, data) {
  try {
    const key = LOG_PREFIX + String(subject).slice(0, 60) + ":" + Date.now();
    await $db.set(key, { event: event, data: data || {}, at: new Date().toISOString() });
  } catch (_e) {}
}

function extractTicket(payload) {
  const data = payload && payload.data ? payload.data : (payload || {});
  if (data.ticket) return data.ticket;
  if (data.ticketData) return data.ticketData;
  if (data.ticket_data) return data.ticket_data;
  if (data.conversation && data.conversation.ticket) return data.conversation.ticket;
  if (data.ticketEvent && data.ticketEvent.ticket) return data.ticketEvent.ticket;
  if (data.ticket_event && data.ticket_event.ticket) return data.ticket_event.ticket;
  if (data.event && data.event.ticket) return data.event.ticket;
  if (data.ticket_id || data.ticketId) return { id: data.ticket_id || data.ticketId, status: data.status, status_name: data.status_name || data.statusName };
  if (data.id && (data.status !== undefined || data.subject !== undefined || data.type === "ticket" || data.changes)) return data;
  return null;
}

function extractTicketId(payload) {
  const data = payload && payload.data ? payload.data : (payload || {});
  const candidates = [
    data.ticket && (data.ticket.id || data.ticket.ticket_id || data.ticket.ticketId || data.ticket.display_id),
    data.ticketData && (data.ticketData.id || data.ticketData.ticket_id || data.ticketData.ticketId || data.ticketData.display_id),
    data.ticket_data && (data.ticket_data.id || data.ticket_data.ticket_id || data.ticket_data.ticketId || data.ticket_data.display_id),
    data.ticketEvent && data.ticketEvent.ticket && (data.ticketEvent.ticket.id || data.ticketEvent.ticket.ticket_id || data.ticketEvent.ticket.display_id),
    data.ticket_event && data.ticket_event.ticket && (data.ticket_event.ticket.id || data.ticket_event.ticket.ticket_id || data.ticket_event.ticket.display_id),
    data.event && data.event.ticket && (data.event.ticket.id || data.event.ticket.ticket_id || data.event.ticket.display_id),
    data.conversation && data.conversation.ticket && (data.conversation.ticket.id || data.conversation.ticket.ticket_id || data.conversation.ticket.display_id),
    data.conversation && data.conversation.ticket_id,
    data.ticket_id,
    data.ticketId,
    data.id
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const value = candidates[i];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function jobKey(ticketId) { return JOB_PREFIX + String(ticketId); }
function scheduleName(ticketId) { return ("bhra_ticket_" + String(ticketId)).slice(0, 80); }
function ticketCatchupScheduleName(ticketId) { return (TICKET_EVENT_CATCHUP_PREFIX + String(ticketId)).slice(0, 80); }

function iparamValues(payload) {
  if (payload && payload.iparams) return payload.iparams;
  if (payload && payload.data && payload.data.iparams) return payload.data.iparams;
  if (typeof iparams !== "undefined" && iparams) return iparams;
  return {};
}

function hostName(payload) {
  const p = iparamValues(payload);
  const candidates = [
    p.freshdesk_domain,
    p.domain,
    p.freshdeskDomain,
    currentHostEndpoint(payload, "freshdesk"),
    currentHostEndpoint(payload, "support_ticket"),
    currentHostEndpoint(payload, "freshdesk_omni")
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    let domain = String(candidates[i] || "").trim();
    if (!domain) continue;
    domain = domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    domain = domain.replace(/\s+/g, "").toLowerCase();
    if (!domain) continue;

    // Allow either "rampforfe" or "rampforfe.freshdesk.com" in app settings.
    // Request templates need a full hostname.
    if (domain.indexOf(".") === -1) domain = domain + ".freshdesk.com";
    return domain;
  }

  throw new Error("Freshdesk domain is not configured and was not present in the event host payload.");
}

function currentHostEndpoint(payload, product) {
  const data = payload && payload.data ? payload.data : {};
  const hosts = [
    payload && payload.currentHost,
    data && data.currentHost,
    payload && payload.host,
    data && data.host
  ];
  for (let i = 0; i < hosts.length; i += 1) {
    const host = hosts[i];
    if (!host || typeof host !== "object") continue;
    const endpoints = host.endpoint_urls || host.endpointUrls || host.endpoints || {};
    if (endpoints && endpoints[product]) return endpoints[product];
    if (host[product]) return host[product];
    if (host.url) return host.url;
    if (host.domain) return host.domain;
  }
  return "";
}

function safeHost(payload) {
  try { return hostName(payload); }
  catch (_error) { return ""; }
}

function isNo(value) {
  const text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  return ["no", "false", "0", "off", "disabled"].indexOf(text) !== -1;
}

function isYes(value) {
  const text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  return ["yes", "true", "1", "on", "enabled"].indexOf(text) !== -1;
}

function boolValue(value, fallback) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  if (typeof value === "boolean") return value;
  if (isYes(value)) return true;
  if (isNo(value)) return false;
  return Boolean(fallback);
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveNumberOrBlank(value) {
  const n = Number(value);
  return value !== undefined && value !== null && String(value).trim() !== "" && Number.isFinite(n) && n > 0 ? n : "";
}

function cleanText(value) { return String(value === undefined || value === null ? "" : value).trim(); }
function capitalize(value) { const text = String(value || ""); return text ? text.charAt(0).toUpperCase() + text.slice(1) : text; }
function pad(n) { return String(n).padStart(2, "0"); }
function errorMessage(error) {
  if (!error) return "Unknown error";
  if (error.message) return error.message;
  try { return JSON.stringify(error); }
  catch (_e) { return String(error); }
}
function toError(error) { return { status: error && error.status ? error.status : 500, message: errorMessage(error) }; }
