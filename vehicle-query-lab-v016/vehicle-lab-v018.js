(function () {
  'use strict';

  const STORAGE_KEY = 'vehicle_query_lab_v1';
  const RETENTION_DAYS = 7;
  const SERVICE_CUTOFF_HOUR = 3;
  const PAGE_TYPES = [
    { id: 'gucheng', label: '古城检修', start: 1, end: 28 },
    { id: 'sihui', label: '四惠检修', start: 31, end: 61 },
    { id: 'tuqiao', label: '土桥段', start: 71, end: 100 }
  ];
  const ALL_TABLES = PAGE_TYPES.flatMap(page => {
    const values = [];
    for (let number = page.start; number <= page.end; number += 1) values.push(formatTable(number));
    return values;
  });
  const WEEKEND_TABLES = [
    ...tableRange(1, 12),
    ...tableRange(31, 40),
    ...tableRange(71, 88)
  ];
  const SCHEDULE_TYPES = {
    weekday: { label: '平日图', tables: ALL_TABLES },
    weekend: { label: '双休日图', tables: WEEKEND_TABLES }
  };

  const originalQuery = window.query;
  const originalClearAll = window.clearAll;
  if (typeof originalQuery !== 'function' || typeof originalClearAll !== 'function') return;

  let store = loadStore();
  let selectedServiceDate = defaultServiceDate();
  let photos = [];
  let reviewRows = [];
  let reviewFilter = 'flagged';
  let reviewPhotoIndex = 0;
  let reviewSource = 'photo';
  let recognitionMeta = emptyRecognitionMeta();
  let activeVehicleQuery = '';
  let lastResolvedTable = '';
  let adjustmentConflict = null;
  let decorateQueued = false;

  function $(id) { return document.getElementById(id); }

  function tableRange(start, end) {
    const values = [];
    for (let number = start; number <= end; number += 1) values.push(formatTable(number));
    return values;
  }

  function emptyRecognitionMeta() {
    return {
      dates: [],
      pageTypes: [],
      dateConflict: false,
      results: [],
      scheduleType: '',
      suggestedScheduleType: '',
      scheduleNeedsConfirmation: false,
      scheduleManuallyConfirmed: false,
      scheduleEvidence: [],
      scheduleConflicts: [],
      planCodes: []
    };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatTable(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 999) return '';
    return number < 100 ? String(number).padStart(2, '0') : String(number);
  }

  function formatVehicle(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!/^\d{1,3}$/.test(raw)) return '';
    const number = Number(raw);
    if (number < 0 || number > 999) return '';
    return String(number).padStart(3, '0');
  }

  function localDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  function addDays(dateString, delta) {
    const parts = String(dateString).split('-').map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    date.setDate(date.getDate() + delta);
    return localDateString(date);
  }

  function defaultServiceDate() {
    const now = new Date();
    if (now.getHours() < SERVICE_CUTOFF_HOUR) now.setDate(now.getDate() - 1);
    return localDateString(now);
  }

  function formatDateLabel(dateString) {
    const parts = String(dateString).split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return dateString;
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return parts[1] + '月' + parts[2] + '日 ' + days[date.getDay()];
  }

  function parseRecognizedDate(value) {
    const text = String(value == null ? '' : value).trim();
    let match = text.match(/(20\d{2})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/);
    if (!match) match = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
    if (!match) return '';
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return '';
    return localDateString(date);
  }

  function recentDates() {
    const start = addDays(defaultServiceDate(), 1);
    return Array.from({ length: RETENTION_DAYS }, (_, index) => addDays(start, -index));
  }

  function loadStore() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return { version: 1, days: {} };
      if (!parsed.days || typeof parsed.days !== 'object') parsed.days = {};
      return { version: 1, days: parsed.days };
    } catch (_) {
      return { version: 1, days: {} };
    }
  }

  function cleanupStore() {
    const allowed = new Set(recentDates());
    Object.keys(store.days).forEach(date => {
      if (!allowed.has(date)) delete store.days[date];
    });
  }

  function saveStore() {
    cleanupStore();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  function dayData(date = selectedServiceDate) {
    return store.days[date] || null;
  }

  function isWeekendDate(dateString) {
    const parts = String(dateString || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return false;
    const day = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
    return day === 0 || day === 6;
  }

  function tablesForScheduleType(type) {
    return (SCHEDULE_TYPES[type] || SCHEDULE_TYPES.weekday).tables.slice();
  }

  function dayScheduleType(data, date = selectedServiceDate) {
    if (data && SCHEDULE_TYPES[data.scheduleType]) return data.scheduleType;
    const tables = Object.keys((data && data.base) || {}).map(formatTable).filter(Boolean);
    if (tables.length >= 60 || tables.some(table => !WEEKEND_TABLES.includes(table))) return 'weekday';
    if (tables.length >= 30 && tables.every(table => WEEKEND_TABLES.includes(table))) return 'weekend';
    return isWeekendDate(date) ? 'weekend' : 'weekday';
  }

  function syncQueryScheduleType(date = selectedServiceDate) {
    const data = dayData(date);
    if (!data || typeof switchMode !== 'function') return;
    const type = dayScheduleType(data, date);
    const activeType = $('tabWeekend') && $('tabWeekend').classList.contains('active') ? 'weekend' : 'weekday';
    if (activeType !== type) switchMode(type);
  }

  function timeToServiceSeconds(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
    if (!match) return 0;
    let seconds = Number(match[1]) * 3600 + Number(match[2]) * 60;
    if (Number(match[1]) < SERVICE_CUTOFF_HOUR) seconds += 86400;
    return seconds;
  }

  function currentQueryTimeText() {
    const hour = $('stationHour') ? $('stationHour').value : '';
    const minute = $('stationMinute') ? $('stationMinute').value : '';
    if (hour) return hour + ':' + (minute || '00');
    const now = new Date();
    return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  }

  function mappingAt(date, timeText) {
    const data = dayData(date);
    if (!data) return {};
    const mapping = Object.assign({}, data.base || {});
    const querySeconds = timeToServiceSeconds(timeText);
    const adjustments = Array.isArray(data.adjustments) ? data.adjustments.slice() : [];
    adjustments.sort((a, b) => timeToServiceSeconds(a.effectiveTime) - timeToServiceSeconds(b.effectiveTime));
    adjustments.forEach(event => {
      if (timeToServiceSeconds(event.effectiveTime) > querySeconds) return;
      Object.entries(event.changes || {}).forEach(([table, vehicle]) => {
        const normalizedTable = formatTable(table);
        if (!normalizedTable) return;
        if (vehicle) mapping[normalizedTable] = formatVehicle(vehicle);
        else delete mapping[normalizedTable];
      });
    });
    return mapping;
  }

  function tableForVehicle(mapping, vehicle) {
    const normalized = formatVehicle(vehicle);
    return Object.keys(mapping).find(table => mapping[table] === normalized) || '';
  }

  function trainForTableAt(table) {
    if (typeof DATA === 'undefined' || typeof getQueryTime !== 'function') return '';
    const normalized = formatTable(table);
    const records = DATA[normalized] || DATA[String(Number(normalized))] || [];
    const queryTime = getQueryTime();
    if (!records.length || !queryTime) return '';
    const querySeconds = queryTime.sec;
    const seconds = value => {
      const parts = String(value || '').split(':').map(Number);
      return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
    };
    const inRange = (value, start, end) => start <= end
      ? value >= start && value <= end
      : value >= start || value <= end;
    const isStopping = record => {
      const arrival = seconds(record.a);
      const departure = seconds(record.p);
      if (!queryTime.custom) return inRange(querySeconds, arrival, departure);
      const minuteEnd = (querySeconds + 59) % 86400;
      const arrivalDistance = (arrival - querySeconds + 86400) % 86400;
      return inRange(querySeconds, arrival, departure) ||
        inRange(minuteEnd, arrival, departure) ||
        arrivalDistance <= 59;
    };
    const stopped = records.find(isStopping);
    if (stopped) return String(stopped.c || '').trim();
    for (let index = 0; index + 1 < records.length; index += 1) {
      const current = records[index];
      const next = records[index + 1];
      const departure = seconds(current.p);
      const arrival = seconds(next.a);
      if (!(querySeconds > departure && querySeconds < arrival)) continue;
      if (typeof isDepot === 'function' && isDepot(current.s) && current.e === current.s) return '';
      return String(current.c || '').trim();
    }
    const last = records[records.length - 1];
    const first = records[0];
    const crossStart = seconds(last.p);
    const crossEnd = seconds(first.a);
    const crossGap = (crossEnd - crossStart + 86400) % 86400;
    if (crossGap > 0 && crossGap <= 7200 && inRange(querySeconds, crossStart, crossEnd)) {
      return String(last.c || '').trim();
    }
    return '';
  }

  function validateMapping(mapping) {
    const errors = [];
    const vehicles = new Map();
    Object.entries(mapping || {}).forEach(([table, vehicle]) => {
      const normalizedTable = formatTable(table);
      const normalizedVehicle = formatVehicle(vehicle);
      if (!normalizedTable) errors.push('表号“' + table + '”格式不正确');
      if (!normalizedVehicle) errors.push('表号' + normalizedTable + '的车号格式不正确');
      if (normalizedVehicle) {
        if (!vehicles.has(normalizedVehicle)) vehicles.set(normalizedVehicle, []);
        vehicles.get(normalizedVehicle).push(normalizedTable);
      }
    });
    vehicles.forEach((tables, vehicle) => {
      if (tables.length > 1) errors.push(vehicle + '车同时对应' + tables.join('、') + '号表');
    });
    return errors;
  }

  function validateDayTimeline(data) {
    const errors = validateMapping(data.base || {});
    if (errors.length) return errors;
    const checkpoints = ['03:00'].concat((data.adjustments || []).map(event => event.effectiveTime));
    for (const time of checkpoints) {
      const temporaryStoreDay = store.days[data.date];
      store.days[data.date] = data;
      const mapping = mappingAt(data.date, time);
      store.days[data.date] = temporaryStoreDay;
      const pointErrors = validateMapping(mapping);
      if (pointErrors.length) return pointErrors.map(error => time + '：' + error);
    }
    return [];
  }

  function pageTypeById(id) {
    return PAGE_TYPES.find(page => page.id === id) || null;
  }

  function pageTypeForTable(table) {
    const number = Number(table);
    return PAGE_TYPES.find(page => number >= page.start && number <= page.end) || null;
  }

  function pageTypeFromText(text) {
    const value = String(text || '');
    if (/古城|古段/.test(value)) return 'gucheng';
    if (/四惠/.test(value)) return 'sihui';
    if (/土桥/.test(value)) return 'tuqiao';
    return '';
  }

  function detectPageType(rows) {
    const counts = new Map(PAGE_TYPES.map(page => [page.id, 0]));
    (rows || []).forEach(row => {
      const table = formatTable(row.table_no || row.table || row.tableNumber);
      const vehicle = formatVehicle(row.effective_vehicle_number || row.changed_vehicle_number || row.vehicle_number || row.train_number);
      const page = pageTypeForTable(table);
      if (page && vehicle) counts.set(page.id, counts.get(page.id) + 1);
    });
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length || ranked[0][1] < 2 || (ranked[1] && ranked[0][1] === ranked[1][1])) return '';
    return ranked[0][0];
  }

  function brandMarkMarkup() {
    return '<span class="vehicle-brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><rect x="4" y="3" width="16" height="14" rx="4"></rect><path d="M8 7h8M8 12h.01M16 12h.01M7 17l-2 4M17 17l2 4M7 21h10"></path></svg></span>';
  }

  function buildInterface() {
    if (document.body.dataset.vehicleLabBuilt === 'true') return;
    document.body.dataset.vehicleLabBuilt = 'true';
    const dateLabel = $('dateLabel');
    const modeTabs = document.querySelector('.mode-tabs');
    const viewModeRow = document.querySelector('.view-mode-row');
    const stationRow = document.querySelector('.station-row');
    const stationTimeRow = document.querySelector('.station-time-row');
    const inputLabel = document.querySelector('.input-label');
    const inputRow = document.querySelector('.input-row');
    const queryPageMessage = $('queryPageMessage');
    const importSection = document.querySelector('.import-section');
    const cardLeft = document.querySelector('.card-left');
    const tableInput = $('tableInput');
    const pageTitle = document.querySelector('body > h1');
    const pageSubtitle = document.querySelector('body > .subtitle');
    const themeMeta = document.querySelector('meta[name="theme-color"]');

    document.body.classList.add('vehicle-lab-dark', 'vehicle-lab-refined');
    if (pageTitle) pageTitle.textContent = '列车车号查询';
    if (pageSubtitle) pageSubtitle.textContent = '实验功能 · 不影响现有列车查询';
    if (themeMeta) themeMeta.setAttribute('content', '#000000');

    if (pageTitle && pageSubtitle) {
      const brand = document.createElement('header');
      brand.className = 'vehicle-lab-brand';
      pageTitle.insertAdjacentElement('beforebegin', brand);
      brand.insertAdjacentHTML('afterbegin', brandMarkMarkup() + '<div class="vehicle-brand-copy"></div>');
      const copy = brand.querySelector('.vehicle-brand-copy');
      copy.appendChild(pageTitle);
      copy.appendChild(pageSubtitle);
      brand.insertAdjacentHTML('afterend',
        '<nav class="vehicle-lab-tabs" aria-label="车号实验功能">' +
          '<button type="button" id="vehicleTopUpload">上传照片</button>' +
          '<button type="button" id="vehicleTopReview">审核校对</button>' +
          '<button type="button" class="active" id="vehicleTopQuery">列车查询</button>' +
        '</nav>'
      );
    }

    const queryHero = document.createElement('div');
    queryHero.className = 'vehicle-query-hero';
    const queryCenter = document.createElement('div');
    queryCenter.className = 'vehicle-query-center';
    const clock = $('clock');
    clock.insertAdjacentElement('beforebegin', queryHero);
    queryHero.appendChild(queryCenter);
    queryCenter.appendChild(clock);
    queryCenter.appendChild(dateLabel);
    queryHero.insertAdjacentHTML('beforeend', '<div class="vehicle-manager-tools"><button type="button" class="vehicle-manager-launch" id="vehicleManagerLaunch">导入车号</button></div>');
    modeTabs.insertAdjacentHTML('beforebegin',
      '<div class="vehicle-date-panel" id="vehicleDatePanel" hidden>' +
        '<div class="vehicle-date-row"><label for="vehicleServiceDate">运行日期</label><select class="vehicle-date-select" id="vehicleServiceDate"></select></div>' +
        '<div class="vehicle-data-status" id="vehicleDataStatus"></div>' +
      '</div>'
    );
    const inputShell = document.createElement('div');
    inputShell.className = 'vehicle-input-shell';
    tableInput.insertAdjacentElement('beforebegin', inputShell);
    inputShell.appendChild(tableInput);
    inputShell.insertAdjacentHTML('beforeend',
      '<div class="vehicle-resolved-choices" id="vehicleResolvedChoices" hidden></div>' +
      '<select class="vehicle-inline-select" id="vehicleQuerySelect" aria-label="选择列车车号"><option value="">选择车号</option></select>'
    );
    inputLabel.textContent = '输入表号、车次或选择车号';

    const controlCard = document.createElement('section');
    controlCard.className = 'vehicle-control-card';
    queryHero.insertAdjacentElement('afterend', controlCard);
    [
      $('vehicleDatePanel'),
      modeTabs,
      viewModeRow,
      stationRow,
      stationTimeRow,
      inputLabel,
      inputRow,
      queryPageMessage,
      importSection
    ].forEach(element => {
      if (element) controlCard.appendChild(element);
    });

    document.body.insertAdjacentHTML('beforeend', managerMarkup());
    fillStaticOptions();
    bindEvents();
    refreshDateOptions();
    syncQueryScheduleType();
    refreshVehicleOptions();
    syncManagerButton();
  }

  function managerMarkup() {
    return '<section class="vehicle-manager-page" id="vehicleManagerPage">' +
      '<header class="vehicle-manager-header">' +
        '<div class="vehicle-manager-brand">' + brandMarkMarkup() + '<div><h2>列车车号查询</h2><p>实验功能 · 独立运行</p></div></div>' +
        '<span class="vehicle-lab-badge" id="vehicleManagerDateBadge" hidden></span>' +
        '<button type="button" class="vehicle-compact-button" id="vehicleManagerBack">返回查询</button>' +
      '</header>' +
      '<div class="vehicle-flow-steps" aria-label="车号实验功能"><button type="button" data-vehicle-nav="upload">上传照片</button><button type="button" data-vehicle-nav="review">审核校对</button><button type="button" data-vehicle-nav="query">列车查询</button></div>' +

      '<div class="vehicle-stage" id="vehicleUploadStage">' +
        '<div class="vehicle-section-head"><div><h3>上传运行计划</h3><p class="vehicle-muted">一次选择三张，顺序不限。系统优先根据左侧表号范围自动分类，检修中心名称仅作辅助。</p></div></div>' +
        '<div class="vehicle-auto-date-panel"><span>运行日期</span><strong>由三张照片自动识别</strong><small>无需提前选择；三张照片日期一致后，自动建立对应日期的数据。</small></div>' +
        '<label class="vehicle-upload-label">选择或拍摄三张照片<input id="vehiclePhotoInput" type="file" accept="image/jpeg,image/png,image/webp" multiple></label>' +
        '<div class="vehicle-photo-grid" id="vehiclePhotoGrid"></div>' +
        '<div class="vehicle-progress" id="vehicleRecognitionProgress"><span></span></div>' +
        '<p class="vehicle-status" id="vehicleRecognitionStatus">请选择三张照片。</p>' +
        '<div class="vehicle-actions"><button type="button" id="vehicleRecognizeButton" disabled>上传并开始识别</button><button type="button" class="vehicle-secondary-button" id="vehicleManualImportButton">手工建立对应关系</button></div>' +
      '</div>' +

      '<div class="vehicle-stage" id="vehicleReviewStage">' +
        '<div class="vehicle-section-head"><div><h3>审核与人工校对</h3><p class="vehicle-muted" id="vehicleReviewSummary"></p></div><button type="button" class="vehicle-compact-button" id="vehicleReviewBack">重新上传</button></div>' +
        '<div class="vehicle-review-toolbar"><div class="vehicle-filter-group"><button type="button" class="active" data-vehicle-filter="flagged">只看需确认</button><button type="button" data-vehicle-filter="all">查看全部</button></div><label class="vehicle-manual-date-field" id="vehicleManualDateField" hidden>手工录入日期<select id="vehicleImportDate"></select></label><span class="vehicle-review-date-status" id="vehicleReviewDateStatus"></span></div>' +
        '<div class="vehicle-schedule-review"><label for="vehicleReviewScheduleType">运行图类型</label><select id="vehicleReviewScheduleType"><option value="">请人工选择</option><option value="weekday">平日图</option><option value="weekend">双休日图</option></select><div class="vehicle-schedule-evidence" id="vehicleScheduleEvidence"></div></div>' +
        '<div class="vehicle-review-layout">' +
          '<div class="vehicle-review-photo"><img id="vehicleReviewPhoto" alt="运行计划原照片"><div class="vehicle-review-photo-controls"><button type="button" id="vehiclePreviousPhoto">上一张</button><button type="button" id="vehicleNextPhoto">下一张</button></div></div>' +
          '<div class="vehicle-table-wrap"><table class="vehicle-table"><thead><tr><th>表号</th><th>最终车号</th><th>识别说明</th></tr></thead><tbody id="vehicleReviewBody"></tbody></table></div>' +
        '</div>' +
        '<p class="vehicle-status" id="vehicleReviewStatus"></p>' +
        '<div class="vehicle-actions"><button type="button" id="vehicleSaveImportButton">保存并导入</button></div>' +
      '</div>' +

      '<div class="vehicle-stage" id="vehicleManageStage">' +
        '<div class="vehicle-section-head"><div><h3>管理当天车号</h3><p class="vehicle-muted" id="vehicleManageSummary"></p></div><button type="button" class="vehicle-compact-button" id="vehicleReimportButton">重新识别照片</button></div>' +
        '<div class="vehicle-manage-grid">' +
          '<div><div class="vehicle-subpanel"><h4>修正初始对应关系</h4><p class="vehicle-muted">用于修正识别错误，不代表从当前时间开始换表。</p><div class="vehicle-table-wrap"><table class="vehicle-table"><thead><tr><th>表号</th><th>初始车号</th></tr></thead><tbody id="vehicleBaseBody"></tbody></table></div><div class="vehicle-actions"><button type="button" class="vehicle-secondary-button" id="vehicleSaveCorrections">保存初始修正</button></div></div></div>' +
          '<div>' +
            '<div class="vehicle-subpanel"><h4>运行中换表</h4><div class="vehicle-fields-grid"><label class="vehicle-field">生效时间<input id="vehicleAdjustTime" type="time"></label><label class="vehicle-field">调整到表号<select id="vehicleAdjustTable"></select></label></div><label class="vehicle-field" style="margin-top:10px;">调整后的车号（留空表示该表暂时无车）<input id="vehicleAdjustNumber" type="text" inputmode="numeric" maxlength="3" placeholder="例如086"></label><div class="vehicle-conflict-box" id="vehicleAdjustmentConflict"><div id="vehicleConflictText"></div><label class="vehicle-field" style="margin-top:8px;">冲突处理<select id="vehicleConflictResolution"><option value="">请选择</option><option value="swap">与原车互换表号</option><option value="replace">原车暂时无表</option></select></label></div><div class="vehicle-actions"><button type="button" id="vehicleSaveAdjustment">保存换表记录</button></div></div>' +
            '<div class="vehicle-subpanel" style="margin-top:12px;"><h4>当天调整记录</h4><div class="vehicle-history" id="vehicleAdjustmentHistory"></div><div class="vehicle-actions"><button type="button" class="vehicle-danger-button" id="vehicleUndoAdjustment">撤销最近一次调整</button></div></div>' +
          '</div>' +
        '</div>' +
        '<p class="vehicle-status" id="vehicleManageStatus"></p>' +
      '</div>' +
    '</section>';
  }

  function fillAdjustmentTableOptions(scheduleType = 'weekday') {
    $('vehicleAdjustTable').innerHTML = tablesForScheduleType(scheduleType).map(table => '<option value="' + table + '">' + table + '号表</option>').join('');
  }

  function fillStaticOptions() {
    fillAdjustmentTableOptions();
  }

  function refreshDateOptions() {
    const dates = recentDates();
    const importedDates = dates.filter(date => dayData(date));
    $('vehicleDatePanel').hidden = importedDates.length === 0;
    if (importedDates.length) {
      if (!importedDates.includes(selectedServiceDate)) selectedServiceDate = importedDates[0];
      $('vehicleServiceDate').innerHTML = importedDates.map(date => '<option value="' + date + '">' + formatDateLabel(date) + '</option>').join('');
      $('vehicleServiceDate').value = selectedServiceDate;
    } else {
      if (!dates.includes(selectedServiceDate)) selectedServiceDate = defaultServiceDate();
      $('vehicleServiceDate').innerHTML = '';
    }
    $('vehicleImportDate').innerHTML = dates.map(date => '<option value="' + date + '">' + formatDateLabel(date) + '</option>').join('');
    if (!dates.includes($('vehicleImportDate').value)) $('vehicleImportDate').value = dates[0];
  }

  function refreshVehicleOptions() {
    const select = $('vehicleQuerySelect');
    const mapping = mappingAt(selectedServiceDate, currentQueryTimeText());
    const entries = Object.entries(mapping).filter(([, vehicle]) => formatVehicle(vehicle));
    entries.sort((a, b) => a[1].localeCompare(b[1], 'zh-CN', { numeric: true }));
    const previous = select.value;
    if (!entries.length) {
      select.innerHTML = '<option value="">尚未导入车号</option>';
      select.disabled = true;
    } else {
      select.innerHTML = '<option value="">选择车号</option>' + entries.map(([, vehicle]) => '<option value="' + vehicle + '">' + vehicle + '车</option>').join('');
      select.disabled = false;
      if (entries.some(([, vehicle]) => vehicle === previous)) select.value = previous;
    }
    const data = dayData(selectedServiceDate);
    $('vehicleDataStatus').textContent = data
      ? '已导入' + Object.keys(data.base || {}).length + '条初始对应，运行中调整' + (data.adjustments || []).length + '次；当前按' + currentQueryTimeText() + '计算。'
      : '该运营日尚未导入车号；表号、车次和车站查询仍可正常使用。';
    syncManagerButton();
    refreshVehicleResolution();
  }

  function hideVehicleResolution() {
    $('vehicleResolvedChoices').hidden = true;
    $('vehicleResolvedChoices').innerHTML = '';
    document.querySelector('.vehicle-input-shell').classList.remove('showing-resolution');
  }

  function clearVehicleSelection() {
    $('vehicleQuerySelect').value = '';
    activeVehicleQuery = '';
    lastResolvedTable = '';
    hideVehicleResolution();
  }

  function refreshVehicleResolution() {
    const select = $('vehicleQuerySelect');
    const vehicle = select.value;
    if (!vehicle) {
      hideVehicleResolution();
      return;
    }
    const mapping = mappingAt(selectedServiceDate, currentQueryTimeText());
    const table = tableForVehicle(mapping, vehicle);
    if (!table) {
      clearVehicleSelection();
      return;
    }
    const train = trainForTableAt(table);
    activeVehicleQuery = vehicle;
    lastResolvedTable = table;
    $('tableInput').value = '';
    const choices = $('vehicleResolvedChoices');
    choices.innerHTML =
      '<button type="button" class="vehicle-resolved-button" data-vehicle-query="' + escapeHtml(String(Number(table))) + '">' + escapeHtml(String(Number(table))) + '号表</button>' +
      (train
        ? '<button type="button" class="vehicle-resolved-button" data-vehicle-query="' + escapeHtml(train) + '">' + escapeHtml(train) + '次</button>'
        : '<span class="vehicle-no-train">此时无运行车次</span>');
    choices.hidden = false;
    document.querySelector('.vehicle-input-shell').classList.add('showing-resolution');
  }

  function chooseVehicleResolution(value) {
    const normalized = String(value || '').trim();
    if (!/^\d{1,4}$/.test(normalized)) return;
    $('tableInput').value = normalized;
    $('vehicleQuerySelect').value = '';
    hideVehicleResolution();
    $('tableInput').blur();
  }

  function syncManagerButton() {
    const data = dayData(selectedServiceDate);
    $('vehicleManagerLaunch').textContent = data ? '管理车号' : '导入车号';
    const badgeText = data ? '运行日期' + formatDateLabel(selectedServiceDate).replace(/\s+周./, '') : '';
    [$('vehicleRunningDateBadge'), $('vehicleManagerDateBadge')].forEach(badge => {
      if (!badge) return;
      badge.textContent = badgeText;
      badge.hidden = !badgeText;
    });
  }

  function openManagerAt(name) {
    document.body.classList.add('vehicle-manager-open');
    showManagerStage(name);
    window.scrollTo(0, 0);
  }

  function openReviewOrManage() {
    if (reviewRows.length) return openManagerAt('review');
    if (dayData(selectedServiceDate)) return openManagerAt('manage');
    openManagerAt('upload');
  }

  function bindEvents() {
    $('vehicleServiceDate').addEventListener('change', () => {
      selectedServiceDate = $('vehicleServiceDate').value;
      $('tableInput').value = '';
      clearVehicleSelection();
      syncQueryScheduleType(selectedServiceDate);
      refreshVehicleOptions();
      queueDecorate();
    });
    ['stationHour', 'stationMinute'].forEach(id => {
      $(id).addEventListener('change', () => setTimeout(() => {
        refreshVehicleOptions();
        queueDecorate();
      }, 0));
    });
    $('tableInput').addEventListener('input', () => {
      if ($('tableInput').value.trim()) {
        clearVehicleSelection();
      }
    });
    $('vehicleQuerySelect').addEventListener('change', refreshVehicleResolution);
    $('vehicleResolvedChoices').addEventListener('click', event => {
      const button = event.target.closest('[data-vehicle-query]');
      if (button) chooseVehicleResolution(button.dataset.vehicleQuery);
    });
    $('vehicleManagerLaunch').addEventListener('click', openManager);
    $('vehicleTopUpload').addEventListener('click', () => openManagerAt('upload'));
    $('vehicleTopReview').addEventListener('click', openReviewOrManage);
    $('vehicleTopQuery').addEventListener('click', closeManager);
    $('vehicleManagerBack').addEventListener('click', closeManager);
    document.querySelectorAll('[data-vehicle-nav]').forEach(button => button.addEventListener('click', () => {
      const target = button.dataset.vehicleNav;
      if (target === 'query') return closeManager();
      if (target === 'review') return openReviewOrManage();
      openManagerAt('upload');
    }));
    $('vehiclePhotoInput').addEventListener('change', handlePhotoSelection);
    $('vehicleRecognizeButton').addEventListener('click', recognizePhotos);
    $('vehicleManualImportButton').addEventListener('click', beginManualReview);
    $('vehicleReviewBack').addEventListener('click', () => showManagerStage('upload'));
    $('vehiclePreviousPhoto').addEventListener('click', () => showReviewPhoto(reviewPhotoIndex - 1));
    $('vehicleNextPhoto').addEventListener('click', () => showReviewPhoto(reviewPhotoIndex + 1));
    document.querySelectorAll('[data-vehicle-filter]').forEach(button => button.addEventListener('click', () => {
      reviewFilter = button.dataset.vehicleFilter;
      document.querySelectorAll('[data-vehicle-filter]').forEach(peer => peer.classList.toggle('active', peer === button));
      renderReviewRows();
    }));
    $('vehicleReviewBody').addEventListener('input', event => {
      const input = event.target.closest('[data-review-table]');
      if (!input) return;
      const row = reviewRows.find(item => item.table === input.dataset.reviewTable);
      if (!row) return;
      row.vehicle = input.value.replace(/\D/g, '').slice(0, 3);
      row.manuallyEdited = true;
      revalidateReviewRows();
      renderReviewSummary();
    });
    $('vehicleSaveImportButton').addEventListener('click', saveReviewedImport);
    $('vehicleReimportButton').addEventListener('click', () => showManagerStage('upload'));
    $('vehicleSaveCorrections').addEventListener('click', saveBaseCorrections);
    $('vehicleSaveAdjustment').addEventListener('click', saveAdjustment);
    $('vehicleUndoAdjustment').addEventListener('click', undoAdjustment);
    $('vehicleImportDate').addEventListener('change', () => {
      if (reviewSource === 'manual') {
        const scheduleType = isWeekendDate($('vehicleImportDate').value) ? 'weekend' : 'weekday';
        recognitionMeta.suggestedScheduleType = scheduleType;
        recognitionMeta.scheduleManuallyConfirmed = true;
        applyReviewScheduleType(scheduleType);
      }
      updateReviewDateStatus();
    });
    $('vehicleReviewScheduleType').addEventListener('change', () => {
      const scheduleType = $('vehicleReviewScheduleType').value;
      if (!SCHEDULE_TYPES[scheduleType]) return;
      recognitionMeta.scheduleManuallyConfirmed = true;
      recognitionMeta.scheduleNeedsConfirmation = false;
      recognitionMeta.scheduleEvidence.push('已由人工确认运行图类型');
      applyReviewScheduleType(scheduleType);
    });
    $('vehiclePhotoGrid').addEventListener('change', event => {
      const select = event.target.closest('[data-photo-index]');
      if (!select) return;
      const photo = photos[Number(select.dataset.photoIndex)];
      if (photo) photo.manualPageType = select.value;
    });

    window.query = enhancedQuery;
    window.clearAll = enhancedClearAll;
    const result = $('result');
    new MutationObserver(queueDecorate).observe(result, { childList: true, subtree: true });
  }

  function showQueryError(message) {
    const result = $('result');
    $('hint').style.display = 'none';
    result.innerHTML = '<p class="error-msg">' + escapeHtml(message) + '</p>';
  }

  function enhancedQuery(openResultPage = true) {
    const raw = $('tableInput').value.trim();
    const selectedVehicle = $('vehicleQuerySelect').value;
    const station = $('stationSelect').value;
    if (!raw && selectedVehicle && !station) {
      if (!openResultPage) {
        refreshVehicleResolution();
        return;
      }
      showQueryError('请先点击输入框中的表号或车次');
      return;
    }
    originalQuery(openResultPage);
    queueDecorate();
  }

  function enhancedClearAll() {
    originalClearAll();
    clearVehicleSelection();
  }

  function queueDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(() => {
      decorateQueued = false;
      decorateResults();
    });
  }

  function decorateResults() {
    const mapping = mappingAt(selectedServiceDate, currentQueryTimeText());
    if (!Object.keys(mapping).length) return;
    document.querySelectorAll('#result .result-meta-row').forEach(row => {
      const queryTag = row.querySelector('.query-tag');
      if (!queryTag) return;
      let table = '';
      const tagMatch = queryTag.textContent.match(/表号\s*(\d{1,3})/);
      if (tagMatch) table = formatTable(tagMatch[1]);
      if (!table) {
        const linked = row.querySelector('.linked-table-btn');
        const linkedMatch = linked ? linked.textContent.match(/(\d{1,3})号表/) : null;
        if (linkedMatch) table = formatTable(linkedMatch[1]);
      }
      if (!table && activeVehicleQuery) table = lastResolvedTable;
      const vehicle = table ? mapping[table] : '';
      let tag = row.querySelector('.vehicle-result-tag');
      if (!vehicle) {
        if (tag) tag.remove();
        return;
      }
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'vehicle-result-tag';
        queryTag.insertAdjacentElement('afterend', tag);
      }
      tag.textContent = '车号 ' + vehicle;
    });
    document.querySelectorAll('#result .bd-train').forEach(cell => {
      const tableElement = cell.querySelector('.bd-table');
      if (!tableElement) return;
      const match = tableElement.textContent.match(/表(\d{1,3})/);
      const table = match ? formatTable(match[1]) : '';
      const vehicle = table ? mapping[table] : '';
      let tag = cell.querySelector('.bd-vehicle');
      if (!vehicle) {
        if (tag) tag.remove();
        return;
      }
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'bd-vehicle';
        tableElement.insertAdjacentElement('afterend', tag);
      }
      tag.textContent = vehicle + '车';
    });
  }

  function openManager() {
    document.body.classList.add('vehicle-manager-open');
    if (dayData(selectedServiceDate)) {
      renderManageStage();
      showManagerStage('manage');
    } else {
      showManagerStage('upload');
    }
    window.scrollTo(0, 0);
  }

  function closeManager() {
    document.body.classList.remove('vehicle-manager-open');
    refreshDateOptions();
    refreshVehicleOptions();
    queueDecorate();
    window.scrollTo(0, 0);
  }

  function showManagerStage(name) {
    const stages = { upload: $('vehicleUploadStage'), review: $('vehicleReviewStage'), manage: $('vehicleManageStage') };
    Object.entries(stages).forEach(([key, element]) => element.classList.toggle('active', key === name));
    document.querySelectorAll('[data-vehicle-nav]').forEach(step => step.classList.toggle('active', step.dataset.vehicleNav === name || (name === 'manage' && step.dataset.vehicleNav === 'review')));
    if (name === 'upload') setRecognitionStatus(photos.length ? '已选择' + photos.length + '张照片。' : '请选择三张照片。');
    if (name === 'manage') renderManageStage();
    window.scrollTo(0, 0);
  }

  function revokePhotos() {
    photos.forEach(photo => {
      if (photo.url) URL.revokeObjectURL(photo.url);
    });
    photos = [];
    $('vehiclePhotoInput').value = '';
    $('vehiclePhotoGrid').innerHTML = '';
    $('vehicleRecognizeButton').disabled = true;
  }

  function handlePhotoSelection() {
    const files = Array.from($('vehiclePhotoInput').files || []).slice(0, 3);
    revokePhotos();
    photos = files.map((file, index) => ({ file, url: URL.createObjectURL(file), index, manualPageType: '', detectedPageType: '', recognizedDate: '', planCode: '', result: null }));
    renderPhotoCards();
    $('vehicleRecognizeButton').disabled = photos.length !== 3;
    if (files.length === 3) setRecognitionStatus('已选择3张照片，上传顺序不限，可以开始识别。', 'success');
    else setRecognitionStatus('需要一次选择3张照片；当前已选择' + files.length + '张。', 'error');
  }

  function renderPhotoCards() {
    $('vehiclePhotoGrid').innerHTML = photos.map((photo, index) => {
      const detected = photo.detectedPageType ? pageTypeById(photo.detectedPageType) : null;
      const options = '<option value="">自动识别照片类型</option>' + PAGE_TYPES.map(page => '<option value="' + page.id + '"' + (photo.manualPageType === page.id ? ' selected' : '') + '>' + page.label + ' · ' + formatTable(page.start) + '—' + formatTable(page.end) + '表</option>').join('');
      const metadata = photo.recognizedDate
        ? '日期：' + formatDateLabel(photo.recognizedDate) + (photo.planCode ? ' · 标题：' + escapeHtml(photo.planCode) : '')
        : '等待识别日期与标题代号';
      return '<article class="vehicle-photo-card"><img src="' + photo.url + '" alt="第' + (index + 1) + '张运行计划"><div class="vehicle-photo-info"><strong>第' + (index + 1) + '张' + (detected ? ' · 已识别' + detected.label : '') + '</strong><select class="vehicle-photo-page-select" data-photo-index="' + index + '">' + options + '</select><span class="vehicle-muted">' + metadata + '</span></div></article>';
    }).join('');
  }

  function setRecognitionStatus(message, type = '') {
    $('vehicleRecognitionStatus').textContent = message;
    $('vehicleRecognitionStatus').className = 'vehicle-status ' + type;
  }

  function setReviewStatus(message, type = '') {
    $('vehicleReviewStatus').textContent = message;
    $('vehicleReviewStatus').className = 'vehicle-status ' + type;
  }

  function compressPhoto(file, max = 2200, quality = 0.88, maxLength = 7200000) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          let currentQuality = quality;
          let data = canvas.toDataURL('image/jpeg', currentQuality);
          while (data.length > maxLength && currentQuality > 0.66) {
            currentQuality -= 0.06;
            data = canvas.toDataURL('image/jpeg', currentQuality);
          }
          if (data.length > maxLength) throw new Error('照片压缩后仍然过大');
          resolve(data);
        } catch (error) {
          reject(error);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('照片读取失败'));
      };
      image.src = url;
    });
  }

  async function workerRequest(path, body) {
    const base = String(localStorage.getItem('ts_worker') || '').replace(/\/+$/, '');
    const token = localStorage.getItem('ts_token') || '';
    if (!base) throw new Error('尚未设置AI识别服务，请先在“车表识别”的设置中填写Worker地址');
    if (!token) throw new Error('本机尚未授权AI识别，请先在“车表识别”中完成设备授权');
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body)
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(data.error || '识别请求失败：' + response.status);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function recognizePhotoBatch() {
    const images = await Promise.all(photos.map(photo => compressPhoto(photo.file)));
    const request = {
      task: 'daily_vehicle_mapping',
      images,
      provider: 'doubao',
      expected_pages: PAGE_TYPES.map(page => ({ id: page.id, label: page.label, table_start: page.start, table_end: page.end })),
      required_metadata: ['service_date', 'document_title', 'plan_code', 'schedule_type'],
      schedule_candidates: [
        { id: 'weekday', label: '平日图', title_codes: ['PR'], expected_tables: ALL_TABLES },
        { id: 'weekend', label: '双休日图', title_codes: ['SX'], compatible_title_codes: ['SGJR'], expected_tables: WEEKEND_TABLES }
      ],
      classification_rule: '先逐张识别日期并确认三张日期一致，再综合标题代号与实际主表号数量判断平日图或双休日图；SGJR是中性代号，不得因其与SX不同而拒绝同日期照片。'
    };
    try {
      return await workerRequest('/recognize-vehicle-map', request);
    } catch (error) {
      if ([404, 405].includes(error.status)) {
        throw new Error('当前AI服务还没有三图车号识别接口，请先更新并部署 TrainSheet-AI 后再试');
      }
      throw error;
    }
  }

  function recognizedPlanCode(response) {
    const candidates = [
      response.plan_code,
      response.planCode,
      response.plan_number,
      response.document_code,
      response.document_title,
      response.title,
      response.header_text
    ].filter(Boolean).join(' ');
    const match = String(candidates).toUpperCase().match(/\b(?:SX|PR|SGJR)[A-Z0-9-]*\d[A-Z0-9-]*\b/);
    return match ? match[0] : '';
  }

  function recognizedScheduleType(response) {
    const value = String(response.schedule_type || response.plan_type || response.timetable_type || '').toLowerCase();
    if (/weekend|double|双休|节假|sx/.test(value)) return 'weekend';
    if (/weekday|workday|平日|工作日|pr/.test(value)) return 'weekday';
    return '';
  }

  function inferenceRows(results) {
    const rows = [];
    results.forEach(result => {
      result.rawRows.forEach(raw => {
        const table = formatTable(raw.table_no || raw.table || raw.tableNumber);
        const vehicle = formatVehicle(raw.effective_vehicle_number || raw.changed_vehicle_number || raw.changed_train_number || raw.replacement_vehicle_number || raw.original_vehicle_number || raw.vehicle_number || raw.train_number);
        if (table && vehicle) rows.push({ table, vehicle });
      });
    });
    return [...new Map(rows.map(row => [row.table, row])).values()];
  }

  function inferScheduleType(date, results, batchResponse) {
    let weekdayScore = 0;
    let weekendScore = 0;
    const evidence = [];
    const conflicts = [];
    const rows = inferenceRows(results);
    const tables = rows.map(row => row.table);
    const planCodes = [...new Set(results.map(result => result.planCode).concat([
      recognizedPlanCode(batchResponse)
    ]).filter(Boolean))];
    const explicitTypes = [...new Set(results.map(result => result.explicitScheduleType).concat([
      recognizedScheduleType(batchResponse)
    ]).filter(Boolean))];
    const hasSx = planCodes.some(code => /^SX/.test(code));
    const hasPr = planCodes.some(code => /^PR/.test(code));
    const hasSgjr = planCodes.some(code => /^SGJR/.test(code));

    if (hasSx) {
      weekendScore += 5;
      evidence.push('标题识别到SX双休日代号');
    }
    if (hasPr) {
      weekdayScore += 5;
      evidence.push('标题识别到PR平日代号');
    }
    if (hasSgjr) evidence.push('土桥段识别到SGJR代号（中性辅助，不阻止同日期合并）');
    if (explicitTypes.includes('weekend')) {
      weekendScore += 4;
      evidence.push('AI元数据判断为双休日图');
    }
    if (explicitTypes.includes('weekday')) {
      weekdayScore += 4;
      evidence.push('AI元数据判断为平日图');
    }
    if (hasSx && hasPr) conflicts.push('三张照片同时出现SX与PR强代号');
    if (explicitTypes.length > 1) conflicts.push('AI返回的运行图类型互相矛盾');

    if (tables.length === WEEKEND_TABLES.length && tables.every(table => WEEKEND_TABLES.includes(table))) {
      weekendScore += 4;
      evidence.push('识别到40个有效主表号，范围与双休日图一致');
    } else if (tables.length >= 70) {
      weekdayScore += 4;
      evidence.push('识别到' + tables.length + '个有效主表号，数量接近平日图');
    } else if (tables.length >= 30 && tables.length <= 50 && tables.every(table => WEEKEND_TABLES.includes(table))) {
      weekendScore += 3;
      evidence.push('识别到' + tables.length + '个有效主表号，且均在双休日范围内');
    } else if (tables.some(table => !WEEKEND_TABLES.includes(table))) {
      weekdayScore += 3;
      evidence.push('识别到双休日范围以外的主表号');
    } else {
      evidence.push('有效主表号共' + tables.length + '个，数量证据不足');
    }

    if (date) {
      if (isWeekendDate(date)) {
        weekendScore += 1;
        evidence.push('运行日期是周末（仅作辅助）');
      } else {
        weekdayScore += 1;
        evidence.push('运行日期是工作日（仅作辅助）');
      }
    }

    const suggestedType = weekendScore > weekdayScore ? 'weekend' : 'weekday';
    const scoreGap = Math.abs(weekendScore - weekdayScore);
    const strongConflict = (hasSx && weekdayScore >= weekendScore) || (hasPr && weekendScore >= weekdayScore);
    if (strongConflict) conflicts.push('标题代号与表号数量或日期证据不一致');
    return {
      type: suggestedType,
      needsConfirmation: conflicts.length > 0 || scoreGap < 3,
      evidence,
      conflicts: [...new Set(conflicts)],
      planCodes,
      rowCount: tables.length,
      scores: { weekday: weekdayScore, weekend: weekendScore }
    };
  }

  function normalizeRecognition(photo, response, batchResponse = {}) {
    const rawRows = Array.isArray(response.rows) ? response.rows : Array.isArray(response.mappings) ? response.mappings : [];
    const responseDepot = response.depot || response.maintenance_center || response.page_type || response.center || '';
    const detectedPageType = photo.manualPageType || pageTypeFromText(responseDepot) || detectPageType(rawRows);
    const recognizedDate = parseRecognizedDate(response.date || response.service_date || response.document_date || response.plan_date || batchResponse.date || batchResponse.service_date || batchResponse.document_date || batchResponse.plan_date);
    const planCode = recognizedPlanCode(response) || recognizedPlanCode(batchResponse);
    const explicitScheduleType = recognizedScheduleType(response);
    photo.detectedPageType = detectedPageType;
    photo.recognizedDate = recognizedDate;
    photo.planCode = planCode;
    photo.result = response;
    return { rawRows, pageType: detectedPageType, date: recognizedDate, planCode, explicitScheduleType };
  }

  function normalizedRow(raw, pageType) {
    const table = formatTable(raw.table_no || raw.table || raw.tableNumber);
    const changed = formatVehicle(raw.changed_vehicle_number || raw.changed_train_number || raw.replacement_vehicle_number);
    const original = formatVehicle(raw.original_vehicle_number || raw.vehicle_number || raw.train_number);
    const effective = formatVehicle(raw.effective_vehicle_number || changed || original);
    const reasons = Array.isArray(raw.review_reasons) ? raw.review_reasons : [];
    const modified = Boolean(raw.vehicle_modified || raw.train_modified || changed);
    const confidence = Number(raw.confidence == null ? 1 : raw.confidence);
    const noteParts = [];
    if (changed) noteParts.push('识别到变更车号' + changed);
    if (modified) noteParts.push('存在划改或重写');
    if (raw.ambiguity) noteParts.push('AI认为不确定');
    if (confidence < 0.88) noteParts.push('置信度较低');
    reasons.forEach(reason => noteParts.push(String(reason)));
    if (raw.note) noteParts.push(String(raw.note));
    return {
      table,
      vehicle: effective,
      originalVehicle: original,
      changedVehicle: changed,
      pageType,
      confidence,
      needsReview: !effective || modified || Boolean(raw.ambiguity) || confidence < 0.88 || reasons.length > 0,
      conflict: false,
      note: [...new Set(noteParts.filter(Boolean))].join('；') || '印刷内容较清晰',
      manuallyEdited: false
    };
  }

  function blankReviewRow(table, note = '等待人工填写') {
    const page = pageTypeForTable(table);
    return {
      table,
      vehicle: '',
      originalVehicle: '',
      changedVehicle: '',
      pageType: page ? page.id : '',
      confidence: 0,
      needsReview: true,
      conflict: false,
      note,
      manuallyEdited: false
    };
  }

  function buildRecognizedReviewRows(results, scheduleType, preservedRows = []) {
    const rawByTable = new Map();
    results.forEach(result => {
      result.rawRows.forEach(raw => {
        const table = formatTable(raw.table_no || raw.table || raw.tableNumber);
        if (table && pageTypeForTable(table)) rawByTable.set(table, { raw, pageType: result.pageType });
      });
    });
    const preserved = new Map(preservedRows.filter(row => row.manuallyEdited).map(row => [row.table, row]));
    return tablesForScheduleType(scheduleType).map(table => {
      const source = rawByTable.get(table);
      const row = source
        ? normalizedRow(source.raw, source.pageType || pageTypeForTable(table).id)
        : blankReviewRow(table, 'AI未返回该表号');
      const edited = preserved.get(table);
      if (edited) {
        row.vehicle = edited.vehicle;
        row.manuallyEdited = true;
        row.needsReview = true;
        row.note = '已人工修改；' + row.note;
      }
      return row;
    });
  }

  function buildManualReviewRows(scheduleType, preservedRows = []) {
    const preserved = new Map(preservedRows.map(row => [row.table, row]));
    return tablesForScheduleType(scheduleType).map(table => preserved.get(table) || blankReviewRow(table));
  }

  function applyReviewScheduleType(scheduleType, preserveRows = true) {
    if (!SCHEDULE_TYPES[scheduleType]) return;
    const previous = preserveRows ? reviewRows : [];
    recognitionMeta.scheduleType = scheduleType;
    reviewRows = reviewSource === 'photo'
      ? buildRecognizedReviewRows(recognitionMeta.results, scheduleType, previous)
      : buildManualReviewRows(scheduleType, previous);
    revalidateReviewRows();
    renderReviewRows();
    renderReviewSummary();
  }

  function renderScheduleReview() {
    const select = $('vehicleReviewScheduleType');
    const evidence = $('vehicleScheduleEvidence');
    if (!select || !evidence) return;
    select.value = recognitionMeta.scheduleNeedsConfirmation && !recognitionMeta.scheduleManuallyConfirmed
      ? ''
      : recognitionMeta.scheduleType;
    const label = SCHEDULE_TYPES[recognitionMeta.suggestedScheduleType || recognitionMeta.scheduleType];
    const parts = [];
    if (reviewSource === 'photo') {
      parts.push(recognitionMeta.scheduleNeedsConfirmation && !recognitionMeta.scheduleManuallyConfirmed
        ? 'AI倾向“' + (label ? label.label : '未知类型') + '”，但证据存在冲突，请人工选择后再保存。'
        : '已判定为“' + (SCHEDULE_TYPES[recognitionMeta.scheduleType] || SCHEDULE_TYPES.weekday).label + '”。');
      if (recognitionMeta.planCodes.length) parts.push('标题代号：' + recognitionMeta.planCodes.join('、') + '。');
      if (recognitionMeta.scheduleEvidence.length) parts.push(recognitionMeta.scheduleEvidence.join('；') + '。');
      if (recognitionMeta.scheduleConflicts.length) parts.push('需注意：' + recognitionMeta.scheduleConflicts.join('；') + '。');
    } else {
      parts.push('手工录入时可按实际运行图选择；切换类型会同步调整需要填写的表号。');
    }
    evidence.textContent = parts.join('');
    evidence.classList.toggle('alert', recognitionMeta.scheduleNeedsConfirmation && !recognitionMeta.scheduleManuallyConfirmed);
  }

  async function recognizePhotos() {
    if (photos.length !== 3) return setRecognitionStatus('请先选择三张照片。', 'error');
    $('vehicleRecognizeButton').disabled = true;
    $('vehicleRecognitionProgress').classList.add('active');
    setRecognitionStatus('正在准备三张照片……');
    try {
      setRecognitionStatus('正在一次识别三张照片，请稍候……');
      const response = await recognizePhotoBatch();
      const responsePages = Array.isArray(response.pages) ? response.pages : [];
      const results = photos.map((photo, index) => {
        const pageResponse = responsePages.find(page => Number(page.image_index) === index + 1) || responsePages[index] || {};
        return normalizeRecognition(photo, pageResponse, response);
      });
      const pageTypes = results.map(result => result.pageType);
      const missingType = pageTypes.findIndex(type => !type);
      if (missingType >= 0) throw new Error('第' + (missingType + 1) + '张照片无法自动判断表号范围，请在照片下方手工选择后重新识别');
      if (new Set(pageTypes).size !== 3) throw new Error('检测到重复的检修中心照片，请检查三张照片类型后重新识别');
      const dates = results.map(result => result.date).filter(Boolean);
      const dateConflict = Boolean(response.date_conflict) || new Set(dates).size > 1;
      const dateReady = dates.length === 3 && !dateConflict;
      const recognizedDate = dateReady ? dates[0] : '';
      const scheduleInference = inferScheduleType(recognizedDate, results, response);
      if (!dateReady) {
        scheduleInference.needsConfirmation = true;
        scheduleInference.conflicts.unshift(dateConflict ? '三张照片日期不一致，必须先处理日期' : '有照片未识别到日期，必须先处理日期');
      }
      recognitionMeta = {
        ...emptyRecognitionMeta(),
        dates,
        pageTypes,
        dateConflict,
        results,
        scheduleType: scheduleInference.type,
        suggestedScheduleType: scheduleInference.type,
        scheduleNeedsConfirmation: scheduleInference.needsConfirmation,
        scheduleEvidence: scheduleInference.evidence,
        scheduleConflicts: scheduleInference.conflicts,
        planCodes: scheduleInference.planCodes
      };
      reviewSource = 'photo';
      $('vehicleManualDateField').hidden = true;
      reviewRows = buildRecognizedReviewRows(results, scheduleInference.type);
      renderPhotoCards();
      renderReviewRows();
      renderReviewSummary();
      renderScheduleReview();
      showReviewPhoto(0);
      showManagerStage('review');
    } catch (error) {
      setRecognitionStatus(error.message, 'error');
    } finally {
      $('vehicleRecognitionProgress').classList.remove('active');
      $('vehicleRecognizeButton').disabled = photos.length !== 3;
    }
  }

  function beginManualReview() {
    revokePhotos();
    reviewSource = 'manual';
    recognitionMeta = {
      ...emptyRecognitionMeta(),
      pageTypes: PAGE_TYPES.map(page => page.id),
      scheduleType: isWeekendDate(recentDates()[0]) ? 'weekend' : 'weekday',
      suggestedScheduleType: isWeekendDate(recentDates()[0]) ? 'weekend' : 'weekday',
      scheduleManuallyConfirmed: true
    };
    $('vehicleManualDateField').hidden = false;
    $('vehicleImportDate').value = recentDates()[0];
    reviewRows = buildManualReviewRows(recognitionMeta.scheduleType);
    revalidateReviewRows();
    renderReviewRows();
    renderReviewSummary();
    renderScheduleReview();
    showReviewPhoto(0);
    showManagerStage('review');
  }

  function revalidateReviewRows() {
    const vehicles = new Map();
    reviewRows.forEach(row => {
      row.conflict = false;
      const vehicle = formatVehicle(row.vehicle);
      if (!vehicle) return;
      if (!vehicles.has(vehicle)) vehicles.set(vehicle, []);
      vehicles.get(vehicle).push(row);
    });
    vehicles.forEach(rows => {
      if (rows.length > 1) rows.forEach(row => { row.conflict = true; });
    });
  }

  function renderReviewRows() {
    revalidateReviewRows();
    $('vehicleReviewBody').innerHTML = reviewRows.map(row => {
      const flagged = row.needsReview || row.conflict || !formatVehicle(row.vehicle);
      const hidden = reviewFilter === 'flagged' && !flagged;
      const classes = [flagged ? 'needs-review' : '', row.conflict ? 'conflict' : '', hidden ? 'hidden-row' : ''].filter(Boolean).join(' ');
      let note = row.conflict ? '车号重复，必须修改' : row.note;
      if (!row.vehicle) note = note ? note + '；车号为空' : '车号为空';
      return '<tr class="' + classes + '"><td><strong>' + row.table + '号表</strong></td><td><input data-review-table="' + row.table + '" value="' + escapeHtml(row.vehicle) + '" maxlength="3" inputmode="numeric" aria-label="' + row.table + '号表最终车号"></td><td><div class="vehicle-row-note ' + (flagged ? 'alert' : '') + '">' + escapeHtml(note) + '</div></td></tr>';
    }).join('');
  }

  function renderReviewSummary() {
    const flagged = reviewRows.filter(row => row.needsReview || row.conflict || !formatVehicle(row.vehicle)).length;
    const conflicts = reviewRows.filter(row => row.conflict).length;
    const filled = reviewRows.filter(row => formatVehicle(row.vehicle)).length;
    $('vehicleReviewSummary').textContent = '共' + reviewRows.length + '个表号，已填写' + filled + '个；' + flagged + '行需要确认，' + conflicts + '行涉及重复冲突。所有车号均可直接修改。';
    updateReviewDateStatus();
    renderScheduleReview();
  }

  function updateReviewDateStatus() {
    const status = $('vehicleReviewDateStatus');
    status.classList.remove('success', 'error');
    const selected = $('vehicleImportDate').value;
    if (reviewSource === 'manual') {
      status.textContent = '手工录入日期：' + formatDateLabel(selected) + '；运行图类型由你确认';
      return;
    }
    if (recognitionMeta.dateConflict) {
      status.textContent = '三张照片日期不一致，禁止保存';
      status.classList.add('error');
      return;
    }
    if (recognitionMeta.dates.length !== 3) {
      status.textContent = '有照片未识别到日期，请重新拍摄或重新识别';
      status.classList.add('error');
      return;
    }
    const recognized = recognitionMeta.dates[0];
    if (!recentDates().includes(recognized)) {
      const dates = recentDates();
      status.textContent = '照片日期为' + formatDateLabel(recognized) + '，不在可保存范围（' + formatDateLabel(dates[dates.length - 1]) + '至' + formatDateLabel(dates[0]) + '）';
      status.classList.add('error');
      return;
    }
    status.textContent = '已自动识别运行日期：' + formatDateLabel(recognized);
    status.classList.add('success');
  }

  function showReviewPhoto(index) {
    const photoPanel = document.querySelector('.vehicle-review-photo');
    if (!photos.length) {
      if (photoPanel) photoPanel.hidden = true;
      $('vehicleReviewPhoto').removeAttribute('src');
      $('vehicleReviewPhoto').alt = '手工录入模式，没有原照片';
      return;
    }
    if (photoPanel) photoPanel.hidden = false;
    reviewPhotoIndex = (index + photos.length) % photos.length;
    $('vehicleReviewPhoto').src = photos[reviewPhotoIndex].url;
    $('vehicleReviewPhoto').alt = '第' + (reviewPhotoIndex + 1) + '张运行计划原照片';
  }

  function saveReviewedImport() {
    setReviewStatus('');
    revalidateReviewRows();
    const duplicateRows = reviewRows.filter(row => row.conflict);
    if (duplicateRows.length) return setReviewStatus('仍有重复车号，请修改后再保存。', 'error');
    if (reviewSource === 'photo' && recognitionMeta.dateConflict) return setReviewStatus('三张照片日期不一致，不能保存。', 'error');
    if (reviewSource === 'photo' && recognitionMeta.dates.length !== 3) return setReviewStatus('有照片未识别到日期，不能保存，请重新拍摄或重新识别。', 'error');
    const scheduleType = $('vehicleReviewScheduleType').value;
    if (!SCHEDULE_TYPES[scheduleType]) return setReviewStatus('请先人工确认本次是平日图还是双休日图。', 'error');
    const date = reviewSource === 'photo' ? recognitionMeta.dates[0] : $('vehicleImportDate').value;
    if (!recentDates().includes(date)) return setReviewStatus('运行日期不在当前可保存范围内。', 'error');
    const base = {};
    reviewRows.forEach(row => {
      const vehicle = formatVehicle(row.vehicle);
      if (vehicle) base[row.table] = vehicle;
    });
    if (!Object.keys(base).length) return setReviewStatus('至少需要填写一条表号和车号对应关系。', 'error');
    const errors = validateMapping(base);
    if (errors.length) return setReviewStatus(errors.join('；'), 'error');
    store.days[date] = {
      date,
      base,
      adjustments: [],
      scheduleType,
      scheduleEvidence: recognitionMeta.scheduleEvidence.slice(),
      planCodes: recognitionMeta.planCodes.slice(),
      importedAt: new Date().toISOString(),
      source: reviewSource === 'photo' ? 'ai-photo-review' : 'manual'
    };
    saveStore();
    selectedServiceDate = date;
    revokePhotos();
    setReviewStatus('已保存。', 'success');
    refreshDateOptions();
    syncQueryScheduleType(date);
    refreshVehicleOptions();
    closeManager();
  }

  function renderManageStage() {
    const data = dayData(selectedServiceDate);
    if (!data) return;
    const scheduleType = dayScheduleType(data, selectedServiceDate);
    data.scheduleType = scheduleType;
    $('vehicleManageSummary').textContent = formatDateLabel(selectedServiceDate) + ' · ' + SCHEDULE_TYPES[scheduleType].label + '：' + Object.keys(data.base || {}).length + '条初始对应，' + (data.adjustments || []).length + '次运行中调整。';
    $('vehicleBaseBody').innerHTML = tablesForScheduleType(scheduleType).map(table => '<tr><td><strong>' + table + '号表</strong></td><td><input data-base-table="' + table + '" value="' + escapeHtml(data.base[table] || '') + '" maxlength="3" inputmode="numeric" aria-label="' + table + '号表初始车号"></td></tr>').join('');
    fillAdjustmentTableOptions(scheduleType);
    const now = new Date();
    $('vehicleAdjustTime').value = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    $('vehicleAdjustNumber').value = '';
    $('vehicleAdjustmentConflict').classList.remove('visible');
    $('vehicleConflictResolution').value = '';
    $('vehicleConflictResolution').querySelector('option[value="swap"]').disabled = false;
    adjustmentConflict = null;
    renderAdjustmentHistory();
    setManageStatus('');
  }

  function setManageStatus(message, type = '') {
    $('vehicleManageStatus').textContent = message;
    $('vehicleManageStatus').className = 'vehicle-status ' + type;
  }

  function saveBaseCorrections() {
    const data = dayData(selectedServiceDate);
    if (!data) return;
    const base = {};
    document.querySelectorAll('[data-base-table]').forEach(input => {
      const vehicle = formatVehicle(input.value);
      if (vehicle) base[input.dataset.baseTable] = vehicle;
    });
    const candidate = Object.assign({}, data, { base });
    const errors = validateDayTimeline(candidate);
    if (errors.length) return setManageStatus('不能保存：' + errors.join('；'), 'error');
    data.base = base;
    data.correctedAt = new Date().toISOString();
    saveStore();
    refreshVehicleOptions();
    renderManageStage();
    setManageStatus('初始对应关系已修正；这不会被记录为运行中换表。', 'success');
  }

  function describeAdjustment(time, targetTable, vehicle, sourceTable, targetVehicle, resolution) {
    if (!vehicle) return time + '：' + targetTable + '号表设为暂时无车';
    if (sourceTable && targetVehicle && resolution === 'swap') return time + '：' + vehicle + '车与' + targetVehicle + '车互换，分别调整到' + targetTable + '号表和' + sourceTable + '号表';
    if (sourceTable) return time + '：' + vehicle + '车由' + sourceTable + '号表调整到' + targetTable + '号表' + (targetVehicle ? '，' + targetVehicle + '车暂时无表' : '');
    return time + '：' + targetTable + '号表调整为' + vehicle + '车' + (targetVehicle ? '，' + targetVehicle + '车暂时无表' : '');
  }

  function saveAdjustment() {
    const data = dayData(selectedServiceDate);
    if (!data) return;
    const time = $('vehicleAdjustTime').value;
    const targetTable = formatTable($('vehicleAdjustTable').value);
    const rawVehicle = $('vehicleAdjustNumber').value.trim();
    const vehicle = rawVehicle ? formatVehicle(rawVehicle) : '';
    if (!time) return setManageStatus('请选择生效时间。', 'error');
    if (rawVehicle && !vehicle) return setManageStatus('车号必须是1～3位数字。', 'error');
    const current = mappingAt(selectedServiceDate, time);
    const sourceTable = vehicle ? tableForVehicle(current, vehicle) : '';
    const targetVehicle = current[targetTable] || '';
    if (sourceTable === targetTable && targetVehicle === vehicle) return setManageStatus('该车已经在目标表号上，无需重复调整。', 'error');

    let resolution = $('vehicleConflictResolution').value;
    if (vehicle && targetVehicle && targetVehicle !== vehicle && !resolution) {
      adjustmentConflict = { time, targetTable, vehicle, sourceTable, targetVehicle };
      const swapOption = $('vehicleConflictResolution').querySelector('option[value="swap"]');
      swapOption.disabled = !sourceTable;
      $('vehicleConflictText').textContent = (sourceTable ? vehicle + '车当前在' + sourceTable + '号表，' : vehicle + '车当前没有表号，') + targetTable + '号表当前是' + targetVehicle + '车。请选择' + targetVehicle + '车如何处理。';
      $('vehicleAdjustmentConflict').classList.add('visible');
      return setManageStatus('检测到车号和表号占用冲突，请先选择处理方式。', 'error');
    }
    if (adjustmentConflict) {
      const sameRequest = adjustmentConflict.time === time && adjustmentConflict.targetTable === targetTable && adjustmentConflict.vehicle === vehicle;
      if (!sameRequest) {
        adjustmentConflict = null;
        $('vehicleAdjustmentConflict').classList.remove('visible');
        resolution = '';
      }
    }
    if (!sourceTable && resolution === 'swap') resolution = 'replace';

    const changes = {};
    if (!vehicle) {
      changes[targetTable] = null;
    } else if (sourceTable && sourceTable !== targetTable) {
      changes[targetTable] = vehicle;
      changes[sourceTable] = resolution === 'swap' && targetVehicle ? targetVehicle : null;
    } else {
      changes[targetTable] = vehicle;
    }
    const event = {
      id: 'adj-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      effectiveTime: time,
      changes,
      description: describeAdjustment(time, targetTable, vehicle, sourceTable, targetVehicle, resolution),
      createdAt: new Date().toISOString()
    };
    const candidate = Object.assign({}, data, { adjustments: (data.adjustments || []).concat(event) });
    const errors = validateDayTimeline(candidate);
    if (errors.length) return setManageStatus('不能保存：' + errors.join('；'), 'error');
    data.adjustments = candidate.adjustments;
    saveStore();
    refreshVehicleOptions();
    renderManageStage();
    setManageStatus('换表记录已保存，查询时会根据生效时间自动采用正确表号。', 'success');
  }

  function renderAdjustmentHistory() {
    const data = dayData(selectedServiceDate);
    const events = data && Array.isArray(data.adjustments) ? data.adjustments.slice() : [];
    events.sort((a, b) => timeToServiceSeconds(a.effectiveTime) - timeToServiceSeconds(b.effectiveTime));
    $('vehicleAdjustmentHistory').innerHTML = events.length
      ? events.map(event => '<div class="vehicle-history-item">' + escapeHtml(event.description || event.effectiveTime + '换表调整') + '</div>').join('')
      : '<div class="vehicle-empty">当天还没有运行中换表记录</div>';
    $('vehicleUndoAdjustment').disabled = !events.length;
  }

  function undoAdjustment() {
    const data = dayData(selectedServiceDate);
    if (!data || !data.adjustments || !data.adjustments.length) return;
    const removed = data.adjustments.pop();
    saveStore();
    refreshVehicleOptions();
    renderManageStage();
    setManageStatus('已撤销：' + (removed.description || '最近一次换表调整'), 'success');
  }

  if (/[?&]vehicle-lab-test(?:=|&|$)/.test(window.location.search)) {
    window.__vehicleLabTest = {
      classify(date, pages, batch = {}) {
        const results = pages.map(page => ({
          rawRows: page.rows || page.mappings || [],
          pageType: page.pageType || page.page_type || pageTypeFromText(page.depot || page.maintenance_center) || detectPageType(page.rows || page.mappings || []),
          date: parseRecognizedDate(page.date || page.service_date || page.document_date || page.plan_date),
          planCode: recognizedPlanCode(page),
          explicitScheduleType: recognizedScheduleType(page)
        }));
        const inference = inferScheduleType(date, results, batch);
        return {
          ...inference,
          reviewTables: buildRecognizedReviewRows(results, inference.type).map(row => row.table)
        };
      },
      tablesForScheduleType
    };
  }

  cleanupStore();
  saveStore();
  buildInterface();
  queueDecorate();
}());
