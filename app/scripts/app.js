(function () {
  "use strict";

  var client = null;
  var currentData = null;
  var currentTicketId = "";
  var countdownTimer = null;
  var liveRefreshTimer = null;
  var isRenderingForm = false;
  var LOCAL_CONFIG_KEY = "businessHoursAutomation.savedConfig.v1514";
  var LOCAL_CONFIG_KEYS = [LOCAL_CONFIG_KEY, "businessHoursAutomation.savedConfig.v1513", "businessHoursAutomation.savedConfig.v1512", "businessHoursAutomation.savedConfig.v1511", "responseAutomation.savedConfig.v1510", "responseAutomation.savedConfig.v159", "responseAutomation.savedConfig.v158", "responseAutomation.savedConfig.v157", "responseAutomation.savedConfig.v156", "responseAutomation.savedConfig.v155", "responseAutomation.savedConfig.v154", "responseAutomation.savedConfig.v153", "responseAutomation.savedConfig.v152", "responseAutomation.savedConfig.v151", "responseAutomation.savedConfig.v150", "responseAutomation.savedConfig.v149", "responseAutomation.savedConfig.v146", "responseAutomation.savedConfig.v145", "responseAutomation.savedConfig.v144", "responseAutomation.savedConfig.v143", "responseAutomation.savedConfig.v142", "responseAutomation.savedConfig.v141", "responseAutomation.savedConfig.v140"];
  var LOCAL_SCHEDULED_KEY = "businessHoursAutomation.scheduledTickets.v1514";
  var LOCAL_SCHEDULED_KEYS = [LOCAL_SCHEDULED_KEY, "businessHoursAutomation.scheduledTickets.v1513", "businessHoursAutomation.scheduledTickets.v1512", "businessHoursAutomation.scheduledTickets.v1511", "responseAutomation.scheduledTickets.v1510", "responseAutomation.scheduledTickets.v159", "responseAutomation.scheduledTickets.v158", "responseAutomation.scheduledTickets.v157", "responseAutomation.scheduledTickets.v156", "responseAutomation.scheduledTickets.v155", "responseAutomation.scheduledTickets.v154", "responseAutomation.scheduledTickets.v153", "responseAutomation.scheduledTickets.v152"];
  var LOCAL_ENABLED_STATE_KEY = "businessHoursAutomation.enabledState.v1514";
  var LOCAL_ENABLED_STATE_KEYS = [LOCAL_ENABLED_STATE_KEY, "businessHoursAutomation.enabledState.v1513", "businessHoursAutomation.enabledState.v1512", "businessHoursAutomation.enabledState.v1511"];

  document.addEventListener("DOMContentLoaded", function () {
    byId("refresh").addEventListener("click", loadData);
    byId("settingsForm").addEventListener("submit", saveSettings);
    byId("automationState").addEventListener("change", saveEnabledPreference);
    byId("removeCurrentAutomation").addEventListener("click", removeCurrentAutomation);
    byId("removeAllScheduled").addEventListener("click", cancelAllScheduledTickets);
    byId("affectedTickets").addEventListener("click", handleAffectedTicketsClick);
    byId("triggerStatusName").addEventListener("change", scheduleAutoResize);
    byId("targetStatusName").addEventListener("change", scheduleAutoResize);

    renderStaticFallback();
    setBusy(true);
    document.addEventListener("freshworks-client-fallback-loaded", function () { waitForClient(0); });
    document.addEventListener("freshworks-client-fallback-failed", function () { show("Freshworks client fallback script could not be loaded. Check browser extensions or network blocking.", "warning"); });
    if (typeof window.__loadFreshworksClientFallback === "function") window.__loadFreshworksClientFallback();
    waitForClient(0);
  });

  function waitForClient(attempt) {
    if (window.app && typeof window.app.initialized === "function") {
      window.app.initialized().then(function (freshClient) {
        client = freshClient;
        show("Connected to Freshworks. Loading live details...", "info");
        scheduleAutoResize();
        loadData();
        try {
          if (client.events && typeof client.events.on === "function") client.events.on("app.activated", function () { if (currentTicketId) loadData(); });
        } catch (_e) {}
      }).catch(function () {
        show("Freshworks client did not initialize. Refresh the ticket page and open the app inside Freshdesk.", "warning");
      });
      return;
    }
    if (attempt === 6 && typeof window.__loadFreshworksClientFallback === "function") window.__loadFreshworksClientFallback();
    if (attempt < 200) setTimeout(function () { waitForClient(attempt + 1); }, 150);
    else show("Freshworks page client did not load. The app must be opened inside Freshdesk.", "warning");
  }

  function loadData() {
    if (!client || !client.request || typeof client.request.invoke !== "function") {
      show("Live details are unavailable because the Freshworks client is not ready.", "warning");
      return;
    }
    setBusy(true);
    getTicketId().then(function (ticketId) {
      currentTicketId = ticketId || "";
      return invoke("getSidebarData", { ticketId: currentTicketId });
    }).then(function (data) {
      currentData = data || {};
      currentData.config = chooseRenderableConfig(currentData.config);
      render(currentData);
      scheduleLiveRefresh();
      var warnings = currentData.warnings || [];
      show(warnings.length ? "Loaded with warnings. Review the warnings section below." : "Live automation details loaded.", warnings.length ? "warning" : "success");
    }).catch(function (err) {
      show("Could not load live details: " + message(err), "warning");
    }).finally(function () {
      setBusy(false);
    });
  }

  function saveSettings(event) {
    event.preventDefault();
    if (!ready()) return;
    var config = readFormConfig();
    config.enabledStateSavedAtMs = Date.now();
    saveLocalEnabledState(config.enabled, config.enabledStateSavedAtMs, true);
    var rule = firstRule(config);
    if (!rule.triggerStatusName || !rule.targetStatusName) {
      show("Please select both ticket statuses before saving the automation rule.", "warning");
      return;
    }
    if (!hasPositiveNumber(rule.delayBusinessHours)) {
      show("Please enter the number of business hours before saving the automation rule.", "warning");
      return;
    }
    setBusy(true);
    saveLocalConfig(config);
    show(config.enabled ? "Saving rule and scheduling matching tickets..." : "Saving rule with automation disabled...", "info");
    invoke("saveAutomationConfig", { config: config, autoScan: true }).then(function (result) {
      currentData = currentData || {};
      currentData.config = normalizeClientConfig((result && result.config) ? result.config : config);
      saveLocalConfig(currentData.config);
      if (result && (Array.isArray(result.scheduled) || Array.isArray(result.alreadyScheduled) || Array.isArray(result.affectedTickets))) {
        applySchedulingResult(result);
      }
      render(currentData);
      var scheduled = Array.isArray(result && result.scheduled) ? result.scheduled.length : 0;
      var already = Array.isArray(result && result.alreadyScheduled) ? result.alreadyScheduled.length : 0;
      var skipped = Array.isArray(result && result.skipped) ? result.skipped.length : 0;
      var found = result && result.found !== undefined ? result.found : 0;
      if (!currentData.config.enabled) {
        show("Automation rule saved as disabled. Background scan/status-change scheduling is off.", "success");
      } else {
        show("Automation rule saved. Scheduled list updated from the backend snapshot: found " + found + ", newly scheduled " + scheduled + ", already scheduled/resynced " + already + ", skipped " + skipped + ".", "success");
      }
    }).catch(function (err) {
      show("Save failed: " + message(err), "warning");
    }).finally(function () { setBusy(false); });
  }

  function saveEnabledPreference(event) {
    if (isRenderingForm) return;
    // Only a real user change should persist ON/OFF. Rendering the form during
    // startup/refresh must never write a default disabled value back to storage.
    if (event && event.isTrusted === false) return;
    var enabled = readEnabledFromControl();
    var existingConfig = normalizeClientConfig((currentData && currentData.config) || loadLocalConfig() || defaultConfig());
    var formConfig = normalizeClientConfig(readFormConfig());
    var config = configHasSelections(formConfig) ? formConfig : existingConfig;
    config.enabled = enabled;
    config.enabledText = enabled ? "true" : "false";
    config.enabledStateSavedAtMs = Date.now();
    saveLocalEnabledState(enabled, config.enabledStateSavedAtMs, true);
    currentData = currentData || {};
    currentData.config = config;
    saveLocalConfig(config);

    if (!client || !client.request || typeof client.request.invoke !== "function") {
      show("Automation " + (enabled ? "enabled" : "disabled") + " locally. Click Save automation rule when Freshworks is connected.", "info");
      return;
    }

    show("Saving automation " + (enabled ? "enabled" : "disabled") + " state...", "info");
    invoke("saveAutomationEnabledState", { enabled: enabled, enabledText: enabled ? "true" : "false", enabledStateSavedAtMs: config.enabledStateSavedAtMs }).then(function (result) {
      if (result && result.config) {
        currentData.config = chooseRenderableConfig(result.config);
        saveLocalConfig(currentData.config);
        saveLocalEnabledState(enabled, configSavedTimestamp(currentData.config) || Date.now(), false);
        setEnabledControl(enabled);
      }
      var cancelled = result && result.cancelled ? Number(result.cancelled) : 0;
      if (!enabled && cancelled) {
        show("Automation disabled and " + cancelled + " pending ticket timer(s) removed.", "success");
      } else {
        show("Automation " + (enabled ? "enabled" : "disabled") + " state saved.", "success");
      }
    }).catch(function (err) {
      // Keep the user's choice in local storage so a refresh does not immediately flip
      // the automation status back because of a stale server read. The next full Save will sync it.
      saveLocalConfig(config);
      show("Automation " + (enabled ? "enabled" : "disabled") + " locally, but backend sync failed: " + message(err), "warning");
    });
  }

  function applySchedulingResult(result) {
    result = result || {};
    var scheduled = Array.isArray(result.scheduled) ? result.scheduled : [];
    var already = Array.isArray(result.alreadyScheduled) ? result.alreadyScheduled : [];
    var affected = Array.isArray(result.affectedTickets)
      ? result.affectedTickets
      : buildAffectedTicketsFromScan(result);
    if ((!affected || !affected.length) && (scheduled.length || already.length)) {
      affected = buildAffectedTicketsFromScan({ scheduled: scheduled, alreadyScheduled: already });
    }

    // Use the backend snapshot as the primary source, but do not allow a partial
    // Freshworks storage read to make valid scheduled tickets disappear from the UI.
    currentData = currentData || {};
    currentData.affectedTickets = chooseStableScheduledList(affected || [], loadLocalScheduledTickets(), false);
    if (currentData.affectedTickets.length) saveLocalScheduledTickets(currentData.affectedTickets);
    renderAffectedTickets(currentData.affectedTickets);
  }

  function scanTickets() {
    if (!ready()) return;
    var config = readFormConfig();
    var rule = firstRule(config);
    if (!config.enabled) {
      show("Enable automation, click Save automation rule, then scan matching tickets.", "warning");
      return;
    }
    if (!rule.triggerStatusName || !rule.targetStatusName) {
      show("Please select both ticket statuses before scanning.", "warning");
      return;
    }
    if (!hasPositiveNumber(rule.delayBusinessHours)) {
      show("Please enter the number of business hours before scanning.", "warning");
      return;
    }
    saveLocalConfig(config);
    setBusy(true);
    show("Scanning tickets that match the automation rule...", "info");
    invoke("scanAndScheduleTickets", { config: config }).then(function (result) {
      var scheduled = Array.isArray(result.scheduled) ? result.scheduled : [];
      var already = Array.isArray(result.alreadyScheduled) ? result.alreadyScheduled : [];
      var skipped = Array.isArray(result.skipped) ? result.skipped : [];
      // Freshworks storage can occasionally return an empty affectedTickets array even
      // though the scan response contains newly scheduled tickets. In that case, build
      // the visible list directly from scheduled/alreadyScheduled and persist it locally.
      var affected = (Array.isArray(result.affectedTickets) && result.affectedTickets.length)
        ? result.affectedTickets
        : buildAffectedTicketsFromScan(result);
      if ((!affected || !affected.length) && (scheduled.length || already.length)) {
        affected = buildAffectedTicketsFromScan({ scheduled: scheduled, alreadyScheduled: already });
      }
      currentData = currentData || {};
      currentData.affectedTickets = chooseStableScheduledList(affected || [], loadLocalScheduledTickets(), false);
      if (currentData.affectedTickets.length) saveLocalScheduledTickets(currentData.affectedTickets);
      renderAffectedTickets(currentData.affectedTickets);
      scheduleAutoResize();
      show("Scan complete. Scheduled list updated from the backend snapshot: found " + (result.found || 0) + ", newly scheduled " + scheduled.length + ", already scheduled/resynced " + already.length + ", skipped " + skipped.length + ".", "success");
    }).catch(function (err) {
      show("Scan failed: " + message(err), "warning");
    }).finally(function () { setBusy(false); });
  }

  function removeCurrentAutomation() {
    if (!ready()) return;
    if (!currentTicketId) {
      show("No current ticket ID is available. Open this app from a ticket sidebar.", "warning");
      return;
    }
    var ok = window.confirm("Remove automation from this ticket? The ticket itself will not be changed.");
    if (!ok) return;
    setBusy(true);
    invoke("cancelCurrentTicketAutomation", { ticketId: currentTicketId }).then(function () {
      removeLocalScheduledTicket(currentTicketId);
      if (currentData && Array.isArray(currentData.affectedTickets)) {
        currentData.affectedTickets = currentData.affectedTickets.filter(function (item) { return String(item.ticketId || "") !== String(currentTicketId); });
      }
      show("Automation removed from this ticket.", "success");
      return loadData();
    }).catch(function (err) {
      show("Could not remove automation from this ticket: " + message(err), "warning");
    }).finally(function () { setBusy(false); });
  }

  function cancelAllScheduledTickets() {
    if (!ready()) return;
    var ok = window.confirm("Remove automation from all currently scheduled tickets? The tickets themselves will not be changed.");
    if (!ok) return;
    setBusy(true);
    show("Removing all scheduled automations...", "info");
    invoke("cancelAllTicketAutomations", {}).then(function (result) {
      clearLocalScheduledTickets();
      renderAffectedTickets([]);
      show("Removed automation from " + (result.cancelled || 0) + " scheduled ticket(s).", "success");
      return loadData();
    }).catch(function (err) {
      show("Could not remove all scheduled automations: " + message(err), "warning");
    }).finally(function () { setBusy(false); });
  }

  function handleAffectedTicketsClick(event) {
    var button = event.target && event.target.closest ? event.target.closest("[data-cancel-ticket]") : null;
    if (!button) return;
    event.preventDefault();
    var ticketId = button.getAttribute("data-cancel-ticket");
    if (!ticketId) return;
    var ok = window.confirm("Remove the scheduled automation for ticket #" + ticketId + "? The ticket itself will not be changed.");
    if (!ok) return;
    setBusy(true);
    invoke("cancelCurrentTicketAutomation", { ticketId: ticketId }).then(function () {
      removeLocalScheduledTicket(ticketId);
      if (currentData && Array.isArray(currentData.affectedTickets)) {
        currentData.affectedTickets = currentData.affectedTickets.filter(function (item) { return String(item.ticketId || "") !== String(ticketId); });
        renderAffectedTickets(currentData.affectedTickets);
      } else {
        renderAffectedTickets(loadLocalScheduledTickets());
      }
      show("Automation removed for ticket #" + ticketId + ".", "success");
      return loadData();
    }).catch(function (err) {
      show("Could not remove automation for ticket #" + ticketId + ": " + message(err), "warning");
    }).finally(function () { setBusy(false); });
  }

  function ready() {
    if (!client || !client.request || typeof client.request.invoke !== "function") {
      show("Freshworks client is not ready. Refresh the Freshdesk page and try again.", "warning");
      return false;
    }
    return true;
  }

  function getTicketId() {
    if (!client || !client.data || typeof client.data.get !== "function") return Promise.resolve("");
    return client.data.get("ticket").then(function (data) {
      var ticket = data && data.ticket ? data.ticket : data;
      return ticket && (ticket.id || ticket.display_id || ticket.ticket_id) ? String(ticket.id || ticket.display_id || ticket.ticket_id) : "";
    }).catch(function () { return ""; });
  }

  function invoke(name, payload) {
    return timeout(client.request.invoke(name, payload || {}), 45000, name).then(function (data) {
      var response = data && data.response !== undefined ? data.response : data;
      if (typeof response === "string") {
        try { return response ? JSON.parse(response) : {}; }
        catch (_e) { return { raw: response }; }
      }
      return response || {};
    }).then(function (response) {
      if (response && response.error) throw new Error(response.message || JSON.stringify(response.error));
      if (response && response.status && Number(response.status) >= 400) throw new Error(response.message || "Server method failed.");
      return response;
    });
  }

  function render(data) {
    data = data || {};
    var config = chooseRenderableConfig(data.config || defaultConfig());
    data.config = config;
    var selectedCalendar = data.selectedCalendarDetails || data.selectedCalendar || defaultCalendarFromList(data.businessHours || []);
    var inTicketSidebar = Boolean(currentTicketId || (data.currentTicket && data.currentTicket.id));
    applyViewMode(inTicketSidebar);
    renderForm(config, data.statuses || [], selectedCalendar);
    var affected = [];
    if (Array.isArray(data.affectedTickets)) {
      affected = chooseStableScheduledList(data.affectedTickets, loadLocalScheduledTickets(), false);
      if (affected.length) saveLocalScheduledTickets(affected);
    } else {
      affected = loadLocalScheduledTickets();
    }
    var currentJob = data.currentJob || findCurrentJobInAffectedList(data.currentTicket || null, currentTicketId, affected);
    renderCurrentTicket(data.currentTicket || null, currentJob || null, data.previewDueAt || null, data.previewRule || null, config);
    renderAffectedTickets(affected || []);
    renderWarnings(data.warnings || []);
    startCountdowns();
    scheduleAutoResize();
  }

  function applyViewMode(inTicketSidebar) {
    var automation = byId("automationCard");
    var scheduled = byId("scheduledTicketsCard");
    var current = byId("currentTicketCard");
    document.body.classList.toggle("ticket-sidebar-mode", Boolean(inTicketSidebar));
    if (automation) automation.hidden = Boolean(inTicketSidebar);
    if (scheduled) scheduled.hidden = Boolean(inTicketSidebar);
    if (current) current.hidden = !Boolean(inTicketSidebar);
    var subtitle = document.querySelector(".hero p");
    if (subtitle) {
      subtitle.textContent = inTicketSidebar ? "Current ticket timer." : "Configure ticket status changes from the app page.";
    }
    scheduleAutoResize();
  }

  function renderStaticFallback() {
    var config = chooseRenderableConfig(loadLocalConfig() || defaultConfig());
    renderForm(config, [], null);
    renderCurrentTicket(null, null, null, null, config);
    renderAffectedTickets(loadLocalScheduledTickets());
    renderWarnings([]);
  }

  function renderForm(config, statuses, selectedCalendar) {
    var rule = firstRule(config);
    isRenderingForm = true;
    try {
      setEnabledControl(boolValue(config.enabled, false));
      setStatusOptions(byId("triggerStatusName"), statuses || [], rule.triggerStatusName || "");
      byId("delayBusinessHours").value = hasPositiveNumber(rule.delayBusinessHours) ? String(rule.delayBusinessHours) : "";
      setStatusOptions(byId("targetStatusName"), statuses || [], rule.targetStatusName || "");
      renderCalendarInlineInfo(selectedCalendar);
    } finally {
      window.setTimeout(function () { isRenderingForm = false; }, 0);
    }
  }

  function setStatusOptions(select, items, selectedName) {
    var wanted = selectedName === undefined || selectedName === null ? "" : String(selectedName).trim();
    select.innerHTML = "";

    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select ticket status";
    placeholder.disabled = true;
    placeholder.selected = !wanted;
    select.appendChild(placeholder);

    var list = Array.isArray(items) ? items.slice() : [];
    var hasWanted = wanted && list.some(function (item) { return norm(item && item.name) === norm(wanted); });
    if (wanted && !hasWanted) list.unshift({ name: wanted, saved: true });
    list.forEach(function (item) {
      if (!item || !item.name) return;
      var opt = document.createElement("option");
      opt.value = String(item.name);
      opt.textContent = String(item.name) + (item.saved ? " (saved)" : "");
      select.appendChild(opt);
    });
    if (!list.length) {
      placeholder.textContent = "Status list not loaded";
    }
    select.value = wanted || "";
  }

  function readFormConfig() {
    var enabled = readEnabledFromControl();
    var rule = {
      id: "rule_1",
      enabled: enabled,
      enabledText: enabled ? "true" : "false",
      name: "Business hours automation",
      priorityOrder: 1,
      priorityName: "Any priority",
      triggerStatusName: byId("triggerStatusName").value.trim(),
      delayBusinessHours: readDelayHours(),
      sendPublicReply: false,
      sendPublicReplyText: "false",
      replyBody: "",
      changeStatus: true,
      changeStatusText: "true",
      targetStatusName: byId("targetStatusName").value.trim()
    };
    return {
      configVersion: "1.5.14",
      enabled: enabled,
      enabledText: enabled ? "true" : "false",
      enabledStateSavedAtMs: 0,
      calendarMode: "freshdesk",
      businessHoursId: "",
      rules: [rule]
    };
  }


  function saveLocalConfig(config) {
    try {
      if (!config || !window.localStorage) return;
      var normalized = normalizeClientConfig(config);
      var serialized = JSON.stringify(normalized);
      // Keep all known config keys in sync so a partial app refresh cannot restore an old blank config.
      LOCAL_CONFIG_KEYS.forEach(function (key) { window.localStorage.setItem(key, serialized); });
    } catch (_e) {}
  }


  function readEnabledFromControl() {
    var select = byId("automationState");
    if (select && select.value) return select.value === "enabled";
    var checkbox = byId("enabled");
    if (checkbox) return Boolean(checkbox.checked);
    var saved = loadLocalEnabledState();
    return saved ? boolValue(saved.enabled !== undefined ? saved.enabled : saved.enabledText, false) : false;
  }

  function setEnabledControl(enabled) {
    var value = enabled ? "enabled" : "disabled";
    var select = byId("automationState");
    if (select) select.value = value;
    var checkbox = byId("enabled");
    if (checkbox) checkbox.checked = Boolean(enabled);
  }

  function saveLocalEnabledState(enabled, savedAtMs, pendingBackendSync) {
    try {
      if (!window.localStorage) return null;
      var record = {
        configVersion: "1.5.14",
        enabled: Boolean(enabled),
        enabledText: enabled ? "true" : "false",
        enabledStateSavedAtMs: Number(savedAtMs || Date.now()),
        pendingBackendSync: Boolean(pendingBackendSync)
      };
      var serialized = JSON.stringify(record);
      LOCAL_ENABLED_STATE_KEYS.forEach(function (key) { window.localStorage.setItem(key, serialized); });
      return record;
    } catch (_e) { return null; }
  }

  function loadLocalEnabledState() {
    try {
      if (!window.localStorage) return null;
      for (var i = 0; i < LOCAL_ENABLED_STATE_KEYS.length; i += 1) {
        var raw = window.localStorage.getItem(LOCAL_ENABLED_STATE_KEYS[i]);
        if (!raw) continue;
        var parsed = JSON.parse(raw);
        if (parsed && (parsed.enabled !== undefined || parsed.enabledText !== undefined)) {
          return {
            configVersion: parsed.configVersion || "1.5.14",
            enabled: boolValue(parsed.enabled !== undefined ? parsed.enabled : parsed.enabledText, false),
            enabledText: boolValue(parsed.enabled !== undefined ? parsed.enabled : parsed.enabledText, false) ? "true" : "false",
            enabledStateSavedAtMs: Number(parsed.enabledStateSavedAtMs || parsed.savedAtMs || 0),
            pendingBackendSync: Boolean(parsed.pendingBackendSync)
          };
        }
      }
      return null;
    } catch (_e) { return null; }
  }

  function loadLocalConfig() {
    try {
      if (!window.localStorage) return null;
      for (var i = 0; i < LOCAL_CONFIG_KEYS.length; i += 1) {
        var raw = window.localStorage.getItem(LOCAL_CONFIG_KEYS[i]);
        if (!raw) continue;
        var parsed = JSON.parse(raw);
        var normalized = normalizeClientConfig(parsed);
        // Older browser snapshots caused the automation status to turn itself on after refresh.
        // Use old keys only for saved rule selections; the enabled/disabled state must
        // come from the current key or the backend.
        if (i > 0 && normalized.configVersion !== "1.5.14" && normalized.configVersion !== "1.5.13" && normalized.configVersion !== "1.5.12") {
          normalized.enabled = false;
          normalized.enabledText = "false";
        }
        if (i === 0 && normalized.enabledStateSavedAtMs) return normalized;
        if (configHasSelections(normalized) || i === LOCAL_CONFIG_KEYS.length - 1) return normalized;
      }
      return null;
    } catch (_e) { return null; }
  }

  function chooseRenderableConfig(serverConfig) {
    var server = normalizeClientConfig(serverConfig || defaultConfig());
    var local = loadLocalConfig();
    var localState = loadLocalEnabledState();

    // The ON/OFF status is stored separately from the rule. That prevents an old
    // rule/config record from turning on automation after the user explicitly turns
    // it off, and also prevents a default disabled record from turning it off after
    // the user explicitly turns it on.
    var serverTs = configSavedTimestamp(server);
    var serverHasExplicitState = configHasExplicitEnabled(server);
    // Whichever explicit ON/OFF state is newest wins. Do not require
    // pendingBackendSync; a successful local ON click must still protect the UI
    // from an older/default disabled response during refresh.
    if (localState && (!serverHasExplicitState || !serverTs || localEnabledStateIsNewer(localState, server))) {
      var selectionSource = configHasSelections(server) ? server : (configHasSelections(local) ? local : server);
      var stateMerge = mergeConfigSelections(localState, selectionSource);
      saveLocalConfig(stateMerge);
      return stateMerge;
    }

    // Freshworks can briefly return a default config while live details load. Preserve
    // saved status selections from the browser, but keep the newest explicit enabled
    // state from the server response or the local state record.
    if (!configHasSelections(server) && configHasSelections(local)) {
      var stateSource = (configHasExplicitEnabled(server) && serverTs) ? server : (localState || local);
      var merged = mergeConfigSelections(stateSource, local);
      saveLocalConfig(merged);
      return merged;
    }

    if (configHasSelections(server) || configHasExplicitEnabled(server)) {
      saveLocalConfig(server);
      if (configHasExplicitEnabled(server)) saveLocalEnabledState(server.enabled, configSavedTimestamp(server) || Date.now(), false);
    }
    return server;
  }

  function localEnabledStateIsNewer(local, server) {
    var localTs = Number(local && local.enabledStateSavedAtMs ? local.enabledStateSavedAtMs : 0);
    if (!localTs) return false;
    var serverTs = configSavedTimestamp(server);
    return !serverTs || localTs > serverTs;
  }

  function configSavedTimestamp(config) {
    if (!config || typeof config !== "object") return 0;
    var candidates = [config.enabledStateSavedAtMs, config.savedAtMs, config.savedAt, config.updatedAt, config.createdAt];
    for (var i = 0; i < candidates.length; i += 1) {
      var value = candidates[i];
      if (value === undefined || value === null || value === "") continue;
      var numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      var parsed = Date.parse(String(value));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
  }

  function configHasExplicitEnabled(config) {
    return Boolean(config
      && (config.enabled !== undefined || config.enabledText !== undefined)
      && (config.enabledStateSavedAtMs || config.savedAtMs || config.savedAt));
  }

  function mergeConfigSelections(authoritativeState, selectionSource) {
    var merged = normalizeClientConfig(selectionSource || defaultConfig());
    var enabled = boolValue(authoritativeState.enabled !== undefined ? authoritativeState.enabled : authoritativeState.enabledText, false);
    merged.enabled = enabled;
    merged.enabledText = enabled ? "true" : "false";
    merged.configVersion = authoritativeState.configVersion || merged.configVersion || "1.5.14";
    merged.savedAt = authoritativeState.savedAt || merged.savedAt;
    merged.savedAtMs = authoritativeState.savedAtMs || merged.savedAtMs;
    merged.enabledStateSavedAtMs = authoritativeState.enabledStateSavedAtMs || merged.enabledStateSavedAtMs || 0;
    return merged;
  }

  function configHasSelections(config) {
    if (!config) return false;
    var rule = firstRule(config);
    return Boolean(rule.triggerStatusName || rule.targetStatusName || hasPositiveNumber(rule.delayBusinessHours));
  }

  function defaultConfig() {
    return {
      configVersion: "1.5.14",
      enabled: false,
      enabledText: "false",
      savedAt: undefined,
      savedAtMs: undefined,
      enabledStateSavedAtMs: 0,
      calendarMode: "freshdesk",
      businessHoursId: "",
      rules: [{
        id: "rule_1",
        enabled: true,
        name: "Business hours automation",
        priorityOrder: 1,
        priorityName: "Any priority",
        triggerStatusName: "",
        delayBusinessHours: "",
        sendPublicReply: false,
        replyBody: "",
        changeStatus: true,
        targetStatusName: ""
      }]
    };
  }

  function normalizeClientConfig(config) {
    var fallback = defaultConfig();
    config = config || {};
    var first = firstRule(config);
    var effectiveEnabled = config.enabled !== undefined ? config.enabled : config.enabledText;
    return {
      configVersion: config.configVersion || fallback.configVersion || "1.5.14",
      savedAt: config.savedAt || undefined,
      savedAtMs: config.savedAtMs || undefined,
      enabledStateSavedAtMs: Number(config.enabledStateSavedAtMs || 0),
      enabled: boolValue(effectiveEnabled, fallback.enabled),
      enabledText: boolValue(effectiveEnabled, fallback.enabled) ? "true" : "false",
      calendarMode: "freshdesk",
      businessHoursId: "",
      rules: [{
        id: "rule_1",
        enabled: true,
        name: "Business hours automation",
        priorityOrder: 1,
        priorityName: "Any priority",
        triggerStatusName: first.triggerStatusName || "",
        delayBusinessHours: hasPositiveNumber(first.delayBusinessHours) ? Number(first.delayBusinessHours) : "",
        sendPublicReply: false,
        replyBody: "",
        changeStatus: true,
        targetStatusName: first.targetStatusName || ""
      }]
    };
  }

  function firstRule(config) {
    var fallback = defaultConfig().rules[0];
    if (config && Array.isArray(config.rules) && config.rules.length) return config.rules[0] || fallback;
    return {
      triggerStatusName: config && config.triggerStatusName ? config.triggerStatusName : "",
      delayBusinessHours: hasPositiveNumber(config && config.delayBusinessHours) ? Number(config.delayBusinessHours) : fallback.delayBusinessHours,
      targetStatusName: config && config.targetStatusName ? config.targetStatusName : ""
    };
  }

  function defaultCalendarFromList(list) {
    if (!Array.isArray(list) || !list.length) return null;
    return list.find(function (item) { return item.isDefault; }) || list[0];
  }

  function renderCalendarInlineInfo(calendar) {
    var el = byId("calendarInlineInfo");
    if (!el) return;
    if (!calendar || !calendar.id) {
      el.className = "calendar-inline warning-line";
      el.innerHTML = "<strong>Freshdesk business hours (default) not loaded yet.</strong><br><span>Click Refresh, or check the Freshdesk domain and admin API key in app settings.</span>";
      return;
    }
    var parts = [];
    parts.push("<strong>Using Freshdesk business hours (default)</strong>");
    parts.push("<span>Calendar: " + esc(displayBusinessHoursName(calendar)) + " | ID: " + esc(calendar.id || "-") + " | Timezone: " + esc(calendar.timeZone || "UTC") + "</span>");
    if (calendar.days) {
      var labels = [["monday", "Mon"], ["tuesday", "Tue"], ["wednesday", "Wed"], ["thursday", "Thu"], ["friday", "Fri"], ["saturday", "Sat"], ["sunday", "Sun"]];
      var dayText = labels.map(function (pair) {
        var cfg = calendar.days[pair[0]] || {};
        return pair[1] + ": " + (cfg.enabled ? ((cfg.start || "-") + "-" + (cfg.end || "-")) : "Closed");
      }).join(" | ");
      parts.push("<span>Working hours: " + esc(dayText) + "</span>");
    }
    var holidays = Array.isArray(calendar.holidays) ? calendar.holidays : [];
    parts.push("<span>Holiday / closed dates from Freshdesk: " + (holidays.length ? esc(holidays.slice(0, 18).join(", ")) + (holidays.length > 18 ? " ..." : "") : "none returned by the Business Hours API") + ".</span>");
    el.className = "calendar-inline";
    el.innerHTML = parts.join("<br>");
  }

  function findCurrentJobInAffectedList(ticket, ticketId, items) {
    var candidates = [];
    function add(value) {
      if (value === undefined || value === null) return;
      var text = String(value).trim();
      if (text && candidates.indexOf(text) === -1) candidates.push(text);
    }
    add(ticketId);
    if (ticket) {
      add(ticket.id);
      add(ticket.ticket_id);
      add(ticket.ticketId);
      add(ticket.display_id);
      add(ticket.displayId);
    }
    var numeric = candidates.map(function (value) { return String(value).replace(/\D+/g, ""); }).filter(Boolean);
    for (var i = 0; i < (items || []).length; i += 1) {
      var item = items[i] || {};
      var id = String(item.ticketId || item.id || item.ticket_id || "").trim();
      if (!id) continue;
      if (candidates.indexOf(id) !== -1 || numeric.indexOf(id.replace(/\D+/g, "")) !== -1) {
        return {
          status: item.status || "pending",
          ticketId: id,
          dueAt: item.dueAt || "",
          createdAt: item.createdAt || "",
          triggerStatusName: item.triggerStatusName || "-",
          targetStatusName: item.targetStatusName || "-",
          businessHoursName: item.businessHoursName || "Freshdesk business hours",
          delayBusinessHours: item.delayBusinessHours || ""
        };
      }
    }
    return null;
  }

  function renderCurrentTicket(ticket, job, previewDueAt, previewRule, config) {
    var timer = "No active timer for this ticket";
    var due = "-";
    if (job && job.status === "pending") {
      timer = "Active - " + remainingText(job.dueAt);
      due = friendly(job.dueAt);
    } else if (job) {
      timer = "Last automation result: " + (job.status || "unknown");
      due = job.completedAt ? friendly(job.completedAt) : (job.dueAt ? friendly(job.dueAt) : "-");
    } else if (previewDueAt) {
      timer = "Eligible now. Would be due in " + remainingText(previewDueAt);
      due = friendly(previewDueAt);
    } else if (ticket && config) {
      timer = "Will start when it matches the automation rule";
    }
    byId("ticketMeta").innerHTML = metaRows([
      ["Ticket", ticket ? ("#" + ticket.id + (ticket.subject ? " - " + ticket.subject : "")) : "Open this app from a ticket sidebar"],
      ["Current status", ticket ? ticket.statusName : "-"],
      ["Timer", timer],
      ["Due time", due]
    ]);
  }

  function renderAffectedTickets(items) {
    var el = byId("affectedTickets");
    var removeAll = byId("removeAllScheduled");
    if (removeAll) removeAll.hidden = !items || !items.length;
    if (!items || !items.length) {
      el.className = "list empty";
      el.textContent = "No tickets are currently scheduled by this app. Save the automation rule to scan existing tickets, or move a ticket into the selected trigger status.";
      return;
    }
    el.className = "list";
    el.innerHTML = "";
    items.forEach(function (item) {
      var div = document.createElement("div");
      div.className = "item ticket-item";
      div.innerHTML = "<div class=\"ticket-row\"><div><strong>Ticket #" + esc(item.ticketId) + "</strong>" +
        (item.subject ? "<span class=\"subject\">" + esc(item.subject) + "</span>" : "") +
        "</div><button class=\"danger mini\" type=\"button\" data-cancel-ticket=\"" + esc(item.ticketId) + "\">Remove automation</button></div>" +
        "<div class=\"chips\">" + chip("Status: " + (item.currentStatusName || "Unknown")) + chip("Due: " + friendly(item.dueAt)) + chip(remainingText(item.dueAt)) + "</div>" +
        "<small>Trigger: " + esc(item.triggerStatusName || "-") + " | Target: " + esc(item.targetStatusName || "-") + " | Calendar: Freshdesk business hours (default)</small>";
      el.appendChild(div);
    });
  }

  function renderWarnings(items) {
    var card = byId("warningsCard");
    var list = byId("warnings");
    if (!items || !items.length) { card.hidden = true; list.innerHTML = ""; return; }
    card.hidden = false;
    list.innerHTML = "";
    items.forEach(function (text) { var li = document.createElement("li"); li.textContent = text; list.appendChild(li); });
  }

  function startCountdowns() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(function () {
      if (currentData) renderCurrentTicket(currentData.currentTicket, currentData.currentJob, currentData.previewDueAt, currentData.previewRule, currentData.config || {});
    }, 30000);
  }

  function setBusy(busy) {
    ["refresh", "saveSettings", "removeCurrentAutomation", "removeAllScheduled"].forEach(function (id) {
      var el = byId(id);
      if (el) el.disabled = Boolean(busy);
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-cancel-ticket]"), function (button) { button.disabled = Boolean(busy); });
  }



  function scheduleLiveRefresh() {
    if (liveRefreshTimer) clearInterval(liveRefreshTimer);
    liveRefreshTimer = null;
    // Do not auto-refresh the full-page scheduled-ticket list. It is a backend
    // snapshot and should stay stable until the user clicks Refresh, saves, scans,
    // or removes a ticket. The sidebar can still refresh because the scheduled
    // list is hidden there and the current-ticket timer needs live status.
    if (!currentTicketId) return;
    liveRefreshTimer = setInterval(function () {
      if (!document.hidden && client) loadData();
    }, 15000);
  }

  function scheduleAutoResize() {
    window.setTimeout(autoResize, 60);
    window.setTimeout(autoResize, 400);
  }

  function autoResize() {
    if (!client || !client.instance || typeof client.instance.resize !== "function") return;
    try {
      var height = Math.max(220, Math.min(900, document.documentElement.scrollHeight || document.body.scrollHeight || 420));
      client.instance.resize({ height: height + "px" });
    } catch (_e) {}
  }

  function metaRows(rows) { return rows.map(function (row) { return "<div><dt>" + esc(row[0]) + "</dt><dd>" + esc(row[1]) + "</dd></div>"; }).join(""); }
  function chip(text) { return "<span class=\"chip\">" + esc(text) + "</span>"; }
  function displayBusinessHoursName(item) {
    item = item || {};
    var name = String(item.name || item.businessHoursName || "Freshdesk business hours").trim();
    var lowered = name.toLowerCase();
    if (item.isDefault || lowered === "general working hours" || lowered === "general working hours (default)") return "Freshdesk business hours";
    return name || "Freshdesk business hours";
  }
  function norm(value) { return String(value || "").trim().toLowerCase().replace(/\s+/g, " "); }
  function friendly(value) { var d = new Date(value); return value && !isNaN(d.getTime()) ? d.toLocaleString() : "-"; }
  function remainingText(value) {
    if (!value) return "No due time";
    var due = new Date(value).getTime();
    if (isNaN(due)) return "Due time unavailable";
    var ms = due - Date.now();
    if (ms <= 0) return "Due now";
    var minutes = Math.ceil(ms / 60000);
    var days = Math.floor(minutes / 1440); minutes -= days * 1440;
    var hours = Math.floor(minutes / 60); minutes -= hours * 60;
    var parts = [];
    if (days) parts.push(days + "d");
    if (hours) parts.push(hours + "h");
    if (minutes || !parts.length) parts.push(minutes + "m");
    return parts.join(" ") + " remaining";
  }

  function buildAffectedTicketsFromScan(result) {
    result = result || {};
    var items = [];
    function add(list) {
      (list || []).forEach(function (item) {
        if (!item || !item.ticketId) return;
        items.push({
          ticketId: String(item.ticketId),
          subject: item.subject || "",
          status: "pending",
          dueAt: item.dueAt || "",
          triggerStatusName: item.triggerStatusName || (firstRule(readFormConfig()).triggerStatusName || "-"),
          targetStatusName: item.targetStatusName || (firstRule(readFormConfig()).targetStatusName || "-"),
          currentStatusName: item.currentStatusName || item.triggerStatusName || "Unknown",
          businessHoursName: "Freshdesk business hours",
          delayBusinessHours: firstRule(readFormConfig()).delayBusinessHours || ""
        });
      });
    }
    add(result.scheduled);
    add(result.alreadyScheduled);
    return dedupeScheduled(items);
  }

  function saveLocalScheduledTickets(items) {
    try {
      if (!window.localStorage) return;
      var list = dedupeScheduled(items || []).slice(0, 300);
      var serialized = JSON.stringify({ savedAt: new Date().toISOString(), items: list });
      // Write every known scheduled-cache key, including empty lists, so older cache keys cannot resurrect removed tickets.
      LOCAL_SCHEDULED_KEYS.forEach(function (key) { window.localStorage.setItem(key, serialized); });
    } catch (_e) {}
  }

  function loadLocalScheduledTickets() {
    try {
      if (!window.localStorage) return [];
      for (var i = 0; i < LOCAL_SCHEDULED_KEYS.length; i += 1) {
        var raw = window.localStorage.getItem(LOCAL_SCHEDULED_KEYS[i]);
        if (!raw) continue;
        var wrapped = JSON.parse(raw);
        var list = Array.isArray(wrapped) ? wrapped : (Array.isArray(wrapped.items) ? wrapped.items : []);
        var normalized = dedupeScheduled(list).filter(function (item) { return item && item.ticketId; });
        if (normalized.length) return normalized;
        if (wrapped && !Array.isArray(wrapped) && Object.prototype.hasOwnProperty.call(wrapped, "items")) return [];
      }
      return [];
    } catch (_e) { return []; }
  }

  function clearLocalScheduledTickets() {
    try {
      if (!window.localStorage) return;
      LOCAL_SCHEDULED_KEYS.forEach(function (key) { window.localStorage.removeItem(key); });
    } catch (_e) {}
  }

  function removeLocalScheduledTicket(ticketId) {
    var id = String(ticketId || "");
    var list = loadLocalScheduledTickets().filter(function (item) { return String(item.ticketId || "") !== id; });
    saveLocalScheduledTickets(list);
  }

  function chooseStableScheduledList(serverItems, localItems, allowEmptyReplace) {
    var server = dedupeScheduled(serverItems || []);
    var local = dedupeScheduled(localItems || []);
    if (!server.length && !allowEmptyReplace) return local;
    // A refresh should never make valid scheduled tickets disappear just because one
    // Freshworks storage read returned a partial snapshot. Prefer the union whenever
    // the browser has a larger recent snapshot; explicit Remove / Remove All still
    // edits local storage separately so cancelled tickets do not come back locally.
    if (local.length > server.length) return mergeScheduledTickets(server, local);
    return server;
  }

  function mergeScheduledTickets(primary, secondary) {
    var merged = [];
    var seen = {};
    function add(list) {
      (list || []).forEach(function (item) {
        var id = String(item && item.ticketId || "");
        if (!id || seen[id]) return;
        seen[id] = true;
        merged.push(item);
      });
    }
    add(primary);
    add(secondary);
    return dedupeScheduled(merged);
  }

  function dedupeScheduled(items) {
    var out = [];
    var seen = {};
    (items || []).forEach(function (item) {
      var id = String(item && item.ticketId || "");
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push(item);
    });
    out.sort(function (a, b) { return new Date(a.dueAt || 0).getTime() - new Date(b.dueAt || 0).getTime(); });
    return out;
  }

  function readDelayHours() {
    var input = byId("delayBusinessHours");
    var value = input ? String(input.value || "").trim() : "";
    if (!value) return "";
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : "";
  }
  function hasPositiveNumber(value) {
    var n = Number(value);
    return value !== undefined && value !== null && String(value).trim() !== "" && Number.isFinite(n) && n > 0;
  }

  function show(text, type) { var el = byId("status"); el.className = "status " + (type || "info"); el.textContent = text; scheduleAutoResize(); }
  function timeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () { if (!done) reject(new Error((label || "Request") + " timed out.")); }, ms);
      promise.then(function (value) { done = true; clearTimeout(timer); resolve(value); }).catch(function (error) { done = true; clearTimeout(timer); reject(error); });
    });
  }
  function message(err) {
    if (!err) return "Unknown error";
    if (err.message) return err.message;
    if (err.response) return typeof err.response === "string" ? err.response : JSON.stringify(err.response);
    return String(err);
  }
  function boolValue(value, fallback) {
    if (value === undefined || value === null || value === "") return Boolean(fallback);
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    var text = String(value).trim().toLowerCase();
    if (["false", "no", "0", "off", "disabled", "unchecked"].indexOf(text) !== -1) return false;
    if (["true", "yes", "1", "on", "enabled", "checked"].indexOf(text) !== -1) return true;
    return Boolean(fallback);
  }
  function esc(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  }
  function byId(id) { return document.getElementById(id); }
})();
