(function () {
  'use strict';

  const STORAGE_KEY = 'vehicle_query_lab_v1';
  const QUERY_HISTORY_KEY = 'vehicle_query_history_v1';
  const QUERY_HISTORY_LIMIT = 10;
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
  let queryHistory = loadQueryHistory();
  let historyScrollTop = 0;

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
      planCodes: [],
      importMode: 'full',
      targetPageType: '',
      targetPageTypes: []
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

  function loadQueryHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(QUERY_HISTORY_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.slice(0, QUERY_HISTORY_LIMIT) : [];
    } catch (_) {
      return [];
    }
  }

  function saveQueryHistory() {
    queryHistory = queryHistory.slice(0, QUERY_HISTORY_LIMIT);
    try {
      localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(queryHistory));
    } catch (_) {
      // 极端情况下逐条移除最旧快照，避免一次超额导致全部历史无法保存。
      while (queryHistory.length > 1) {
        queryHistory.pop();
        try {
          localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(queryHistory));
          break;
        } catch (_) {}
      }
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

  function importedPageTypes(data) {
    if (!data) return [];
    if (data.importedPages && typeof data.importedPages === 'object') {
      return PAGE_TYPES.map(page => page.id).filter(pageType => data.importedPages[pageType]);
    }
    // 旧版本只支持三张完整导入；没有 importedPages 的历史数据视为3/3。
    return PAGE_TYPES.map(page => page.id);
  }

  function importedPageCount(data) {
    return importedPageTypes(data).length;
  }

  function isPageImported(data, pageType) {
    return importedPageTypes(data).includes(pageType);
  }

  function isTablePageImported(data, table) {
    const page = pageTypeForTable(table);
    return Boolean(page && isPageImported(data, page.id));
  }

  function importProgressText(data) {
    const count = importedPageCount(data);
    return count >= PAGE_TYPES.length ? '已完整导入' : '已导入' + count + '/3';
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
    if (typeof switchMode !== 'function') return;
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

  function tableBelongsToPageType(table, pageType) {
    const page = pageTypeById(pageType);
    const number = Number(table);
    return Boolean(page && number >= page.start && number <= page.end);
  }

  function tablesForPageType(pageType, scheduleType) {
    return tablesForScheduleType(scheduleType).filter(table => tableBelongsToPageType(table, pageType));
  }

  function isSupportedPhotoCount(count) {
    return count >= 1 && count <= 3;
  }

  function partialImportPageTypes() {
    const values = recognitionMeta.targetPageTypes && recognitionMeta.targetPageTypes.length
      ? recognitionMeta.targetPageTypes
      : [recognitionMeta.targetPageType];
    return [...new Set(values.filter(Boolean))];
  }

  function isPartialImport() {
    return recognitionMeta.importMode === 'partial' || recognitionMeta.importMode === 'single';
  }

  function mergeSelectedPageData(existing, rows, pageTypes, scheduleType) {
    const selectedPages = new Set(pageTypes.filter(Boolean));
    const targetTables = new Set(tablesForScheduleType(scheduleType).filter(table => {
      const page = pageTypeForTable(table);
      return Boolean(page && selectedPages.has(page.id));
    }));
    const base = Object.assign({}, existing.base || {});
    targetTables.forEach(table => { delete base[table]; });
    rows.forEach(row => {
      if (!targetTables.has(row.table)) return;
      const vehicle = formatVehicle(row.vehicle);
      if (vehicle) base[row.table] = vehicle;
    });
    const removedAdjustments = [];
    const adjustments = (existing.adjustments || []).filter(event => {
      const affected = Object.keys(event.changes || {}).some(table => targetTables.has(formatTable(table)));
      if (affected) removedAdjustments.push(event);
      return !affected;
    });
    return { base, adjustments, removedAdjustments, targetTables: [...targetTables] };
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
    queryHero.insertAdjacentHTML('beforeend', '<div class="vehicle-manager-tools"><button type="button" class="vehicle-history-launch" id="vehicleHistoryLaunch">查询历史</button><button type="button" class="vehicle-manager-launch" id="vehicleManagerLaunch">导入车号</button></div>');
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
      inputLabel,
      inputRow,
      stationRow,
      stationTimeRow,
      queryPageMessage,
      importSection
    ].forEach(element => {
      if (element) controlCard.appendChild(element);
    });

    document.body.insertAdjacentHTML('beforeend', managerMarkup() + historyMarkup());
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
        '<div class="vehicle-section-head"><div><h3>上传运行计划</h3><p class="vehicle-muted">可选择1至3张：只覆盖所选照片对应的表号范围；三张齐全时完整导入。上传顺序不限。</p></div></div>' +
        '<div class="vehicle-auto-date-panel"><span>运行日期</span><strong>由照片自动识别</strong><small>所选照片日期必须一致；两张可作为同一批次整体更新，避免跨范围换车被误判为冲突。</small></div>' +
        '<label class="vehicle-upload-label">选择或拍摄1至3张照片<input id="vehiclePhotoInput" type="file" accept="image/jpeg,image/png,image/webp" multiple></label>' +
        '<div class="vehicle-photo-grid" id="vehiclePhotoGrid"></div>' +
        '<div class="vehicle-progress" id="vehicleRecognitionProgress"><span></span></div>' +
        '<p class="vehicle-status" id="vehicleRecognitionStatus">请选择1至3张照片。</p>' +
        '<div class="vehicle-actions"><button type="button" id="vehicleRecognizeButton" disabled>上传并开始识别</button><button type="button" class="vehicle-secondary-button" id="vehicleManualImportButton">手工建立对应关系</button></div>' +
        '<p class="vehicle-ai-quota" id="vehicleAiQuota" hidden></p>' +
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

  function historyMarkup() {
    return '<section class="vehicle-history-overlay" id="vehicleHistoryOverlay" hidden>' +
      '<div class="vehicle-history-dialog" role="dialog" aria-modal="true" aria-labelledby="vehicleHistoryTitle">' +
        '<header class="vehicle-history-header"><div><h2 id="vehicleHistoryTitle">查询历史</h2><p>本机最近10次成功查询</p></div><button type="button" id="vehicleHistoryClose">关闭</button></header>' +
        '<div class="vehicle-query-history-list" id="vehicleQueryHistoryList"></div>' +
        '<button type="button" class="vehicle-history-clear" id="vehicleHistoryClear">清空全部</button>' +
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
      const today = defaultServiceDate();
      const selectableDates = [today].concat(importedDates.filter(date => date !== today));
      if (!selectableDates.includes(selectedServiceDate)) selectedServiceDate = today;
      $('vehicleServiceDate').innerHTML = selectableDates.map(date => {
        const data = dayData(date);
        const imported = Boolean(data);
        const progress = imported ? ' · ' + importProgressText(data) : '';
        if (date === today) {
          return '<option value="' + date + '">今天（' + formatDateLabel(date) + progress + '）</option>';
        }
        return '<option value="' + date + '">' + formatDateLabel(date) + '（' + importProgressText(data) + '）</option>';
      }).join('');
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
      select.innerHTML = '<option value="">未导入车号</option>';
      select.disabled = true;
    } else {
      select.innerHTML = '<option value="">选择车号</option>' + entries.map(([, vehicle]) => '<option value="' + vehicle + '">' + vehicle + '车</option>').join('');
      select.disabled = false;
      if (entries.some(([, vehicle]) => vehicle === previous)) select.value = previous;
    }
    const data = dayData(selectedServiceDate);
    $('vehicleDataStatus').textContent = data
      ? importProgressText(data) + '，共' + Object.keys(data.base || {}).length + '条初始对应，运行中调整' + (data.adjustments || []).length + '次；当前按' + currentQueryTimeText() + '计算。'
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
       