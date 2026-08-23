(function () {
  'use strict';

  const STORAGE_KEY = 'vehicle_query_lab_v1';
  const QUERY_HISTORY_KEY = 'vehicle_query_history_v1';
  const QUERY_HISTORY_LIMIT = 10;
  const HANDWRITING_MEMORY_KEY = 'vehicle_handwriting_examples_v1';
  const HANDWRITING_MEMORY_LIMIT = 12;
  const HANDWRITING_REQUEST_LIMIT = 4;
  const COMPOSITE_MIN_ASPECT_RATIO = 1.15;
  const COMPOSITE_PAGE_COUNT = 3;
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
  let handwritingExamples = loadHandwritingExamples();
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

  function normalizeCellBbox(value) {
    if (!Array.isArray(value) || value.length !== 4) return [];
    const box = value.map(Number);
    if (box.some(number => !Number.isFinite(number))) return [];
    const normalized = box.map(number => Math.max(0, Math.min(1000, Math.round(number))));
    if (normalized[2] - normalized[0] < 5 || normalized[3] - normalized[1] < 5) return [];
    return normalized;
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

  function loadHandwritingExamples() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HANDWRITING_MEMORY_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(example =>
        example && /^data:image\/jpeg;base64,/.test(String(example.image || '')) &&
        /^\d{3}$/.test(String(example.confirmed_value || ''))
      ).slice(0, HANDWRITING_MEMORY_LIMIT);
    } catch (_) {
      return [];
    }
  }

  function saveHandwritingExamples(examples) {
    const combined = examples.concat(handwritingExamples);
    const seen = new Set();
    handwritingExamples = combined.filter(example => {
      const key = String(example.confirmed_value || '') + ':' + String(example.image || '').slice(-96);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, HANDWRITING_MEMORY_LIMIT);
    while (handwritingExamples.length) {
      try {
        localStorage.setItem(HANDWRITING_MEMORY_KEY, JSON.stringify(handwritingExamples));
        break;
      } catch (_) {
        handwritingExamples.pop();
      }
    }
    refreshHandwritingMemoryStatus();
  }

  function clearHandwritingExamples() {
    if (!handwritingExamples.length) return;
    if (!window.confirm('清除本机保存的全部局部笔迹样本？已导入的车号数据不会受到影响。')) return;
    handwritingExamples = [];
    localStorage.removeItem(HANDWRITING_MEMORY_KEY);
    refreshHandwritingMemoryStatus();
  }

  function requestHandwritingExamples() {
    return handwritingExamples.slice(0, HANDWRITING_REQUEST_LIMIT).map(example => ({
      image: example.image,
      confirmed_value: example.confirmed_value,
      original_value: example.original_value || '',
      model_value: example.model_value || ''
    }));
  }

  function refreshHandwritingMemoryStatus() {
    const summary = $('vehicleHandwritingMemorySummary');
    const clear = $('vehicleClearHandwritingMemory');
    if (!summary || !clear) return;
    summary.textContent = handwritingExamples.length
      ? '本机已保存' + handwritingExamples.length + '条人工确认的局部笔迹样本；识别时最多引用最近' + HANDWRITING_REQUEST_LIMIT + '条。'
      : '本机暂无人工确认的笔迹样本。只保存变更车号格小图，不保存整张照片。';
    clear.hidden = !handwritingExamples.length;
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
        '<div class="vehicle-section-head"><div><h3>上传运行计划</h3><p class="vehicle-muted">可选择1至3张：只覆盖所选照片对应的表号范围；三张齐全时完整导入。也支持一张横向照片同时拍入三张运行计划，系统会自动拆分识别。</p></div></div>' +
        '<div class="vehicle-auto-date-panel"><span>运行日期</span><strong>由照片自动识别</strong><small>所选照片日期必须一致；两张可作为同一批次整体更新，避免跨范围换车被误判为冲突。</small></div>' +
        '<label class="vehicle-upload-label">选择或拍摄1至3张照片<input id="vehiclePhotoInput" type="file" accept="image/jpeg,image/png,image/webp" multiple></label>' +
        '<div class="vehicle-photo-grid" id="vehiclePhotoGrid"></div>' +
        '<div class="vehicle-progress" id="vehicleRecognitionProgress"><span></span></div>' +
        '<p class="vehicle-status" id="vehicleRecognitionStatus">请选择1至3张照片。</p>' +
        '<div class="vehicle-actions"><button type="button" id="vehicleRecognizeButton" disabled>上传并开始识别</button><button type="button" class="vehicle-secondary-button" id="vehicleManualImportButton">手工建立对应关系</button></div>' +
        '<p class="vehicle-ai-quota" id="vehicleAiQuota" hidden></p>' +
        '<div class="vehicle-handwriting-memory"><span id="vehicleHandwritingMemorySummary"></span><button type="button" class="vehicle-link-button" id="vehicleClearHandwritingMemory" hidden>清除笔迹样本</button></div>' +
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
    // 只有用户实际点到输入框外时才移走光标；定时刷新不得影响键盘。
    document.addEventListener('pointerdown', event => {
      const input = $('tableInput');
      if (document.activeElement === input && event.target !== input) {
        input.blur();
      }
    }, true);
    $('vehicleQuerySelect').addEventListener('change', refreshVehicleResolution);
    $('vehicleResolvedChoices').addEventListener('click', event => {
      const button = event.target.closest('[data-vehicle-query]');
      if (button) chooseVehicleResolution(button.dataset.vehicleQuery);
    });
    $('vehicleManagerLaunch').addEventListener('click', openManager);
    $('vehicleHistoryLaunch').addEventListener('click', openQueryHistory);
    $('vehicleHistoryClose').addEventListener('click', closeQueryHistory);
    $('vehicleHistoryOverlay').addEventListener('click', event => {
      if (event.target === $('vehicleHistoryOverlay')) closeQueryHistory();
    });
    $('vehicleQueryHistoryList').addEventListener('click', handleHistoryAction);
    $('vehicleHistoryClear').addEventListener('click', clearQueryHistory);
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
    $('vehicleClearHandwritingMemory').addEventListener('click', clearHandwritingExamples);
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
      row.manuallyEdited = formatVehicle(row.vehicle) !== formatVehicle(row.modelVehicle);
      revalidateReviewRows();
      refreshRenderedReviewValidation();
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
    setResultPageTitle('查询结果');
    const raw = $('tableInput').value.trim();
    const selectedVehicle = $('vehicleQuerySelect').value;
    const station = $('stationSelect').value;
    const historyContext = openResultPage === false ? null : captureQueryContext(raw, station);
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
    if (historyContext) {
      requestAnimationFrame(() => {
        decorateResults();
        recordQueryHistory(historyContext);
      });
    }
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
    decorateDepotInfo();
    const data = dayData(selectedServiceDate);
    const mapping = mappingAt(selectedServiceDate, currentQueryTimeText());
    const partialData = Boolean(data && importedPageCount(data) < PAGE_TYPES.length);
    if (!Object.keys(mapping).length && !partialData) return;
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
      const tablePage = table ? pageTypeForTable(table) : null;
      const missingPage = Boolean(!vehicle && tablePage && partialData && !isPageImported(data, tablePage.id));
      let tag = row.querySelector('.vehicle-result-tag');
      if (!vehicle && !missingPage) {
        if (tag) tag.remove();
        return;
      }
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'vehicle-result-tag';
        queryTag.insertAdjacentElement('afterend', tag);
      }
      tag.className = 'vehicle-result-tag' + (missingPage ? ' vehicle-missing-tag' : '');
      tag.textContent = missingPage ? '车号尚未导入' : '车号 ' + vehicle;
    });
    document.querySelectorAll('#result .bd-train').forEach(cell => {
      const tableElement = cell.querySelector('.bd-table');
      if (!tableElement) return;
      const match = tableElement.textContent.match(/表(\d{1,3})/);
      const table = match ? formatTable(match[1]) : '';
      const vehicle = table ? mapping[table] : '';
      const tablePage = table ? pageTypeForTable(table) : null;
      const missingPage = Boolean(!vehicle && tablePage && partialData && !isPageImported(data, tablePage.id));
      let tag = cell.querySelector('.bd-vehicle');
      if (!vehicle && !missingPage) {
        if (tag) tag.remove();
        return;
      }
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'bd-vehicle';
        tableElement.insertAdjacentElement('afterend', tag);
      }
      tag.className = 'bd-vehicle' + (missingPage ? ' vehicle-missing-tag' : '');
      tag.textContent = missingPage ? '车号未导入' : vehicle + '车';
    });
  }

  function decorateDepotInfo() {
    document.querySelectorAll('#result .depot-info').forEach(info => {
      if (info.dataset.vehicleStructured === 'true') return;
      const entries = info.textContent.split(/\s*[·•]\s*/).map(text => text.trim()).filter(Boolean);
      if (!entries.length) return;
      info.classList.add('vehicle-depot-grid');
      info.innerHTML = entries.map(entry => {
        const match = entry.match(/^(.+?)\s+(\d{1,2}:\d{2}:\d{2})\s+(出库|回库)$/);
        if (!match) return '<span class="vehicle-depot-item"><span>' + escapeHtml(entry) + '</span></span>';
        return '<span class="vehicle-depot-item"><span class="vehicle-depot-name">' + escapeHtml(match[1]) + '</span><time>' + escapeHtml(match[2]) + '</time><span class="vehicle-depot-action">' + escapeHtml(match[3]) + '</span></span>';
      }).join('');
      info.dataset.vehicleStructured = 'true';
    });
  }

  function captureQueryContext(raw, station) {
    const hour = $('stationHour') ? $('stationHour').value : '';
    const minute = $('stationMinute') ? $('stationMinute').value : '';
    const vehicle = activeVehicleQuery || '';
    const table = lastResolvedTable || '';
    const mode = $('tabWeekend') && $('tabWeekend').classList.contains('active') ? 'weekend' : 'weekday';
    return {
      raw,
      station: station || '',
      hour,
      minute,
      vehicle,
      table,
      mode,
      serviceDate: selectedServiceDate,
      requestedTime: hour ? hour + ':' + (minute || '00') : ''
    };
  }

  function queryHistorySummary(context) {
    let subject = '';
    if (context.vehicle) {
      subject = '车号 ' + context.vehicle;
      if (context.raw) subject += context.raw.length === 4 ? ' · 车次 ' + context.raw : ' · ' + String(Number(context.raw)) + '号表';
    } else if (context.raw) {
      subject = context.raw.length === 4 ? '车次 ' + context.raw : String(Number(context.raw)) + '号表';
    } else if (context.station) {
      subject = context.station + '实时看板';
    }
    if (context.station && context.raw) subject += ' · 到站 ' + context.station;
    return subject || '列车查询';
  }

  function hasSuccessfulQueryResult() {
    const result = $('result');
    return Boolean(result && result.textContent.trim() && !result.querySelector('.error-msg'));
  }

  function recordQueryHistory(context) {
    if (!hasSuccessfulQueryResult()) return;
    const createdAt = Date.now();
    queryHistory.unshift({
      id: createdAt.toString(36) + Math.random().toString(36).slice(2, 7),
      createdAt,
      summary: queryHistorySummary(context),
      serviceDate: context.serviceDate,
      mode: context.mode,
      raw: context.raw,
      station: context.station,
      hour: context.hour,
      minute: context.minute,
      vehicle: context.vehicle,
      table: context.table,
      requestedTime: context.requestedTime,
      resultHtml: $('result').innerHTML
    });
    saveQueryHistory();
  }

  function formatHistoryOperationTime(timestamp) {
    const value = new Date(Number(timestamp));
    if (Number.isNaN(value.getTime())) return '';
    const now = new Date();
    const sameDay = value.getFullYear() === now.getFullYear() && value.getMonth() === now.getMonth() && value.getDate() === now.getDate();
    const time = String(value.getHours()).padStart(2, '0') + ':' + String(value.getMinutes()).padStart(2, '0');
    return sameDay ? '今天 ' + time : (value.getMonth() + 1) + '月' + value.getDate() + '日 ' + time;
  }

  function renderQueryHistory() {
    const list = $('vehicleQueryHistoryList');
    $('vehicleHistoryClear').disabled = queryHistory.length === 0;
    if (!queryHistory.length) {
      list.innerHTML = '<div class="vehicle-history-empty"><strong>还没有查询历史</strong><span>成功查询后会自动保留在这里。</span></div>';
      return;
    }
    list.innerHTML = queryHistory.map(entry => {
      const detail = [
        formatDateLabel(entry.serviceDate || ''),
        entry.requestedTime ? '指定 ' + entry.requestedTime : '使用当时时间',
        entry.station && !entry.raw ? '' : (entry.station ? '到站 ' + entry.station : '')
      ].filter(Boolean).join(' · ');
      return '<article class="vehicle-history-card" data-history-id="' + escapeHtml(entry.id) + '">' +
        '<div class="vehicle-history-card-head"><strong>' + escapeHtml(entry.summary || '列车查询') + '</strong><time>' + escapeHtml(formatHistoryOperationTime(entry.createdAt)) + '</time></div>' +
        '<p>' + escapeHtml(detail) + '</p>' +
        '<div class="vehicle-history-actions"><button type="button" data-history-action="view">查看结果</button><button type="button" data-history-action="rerun">再次查询</button><button type="button" class="danger" data-history-action="delete">删除</button></div>' +
      '</article>';
    }).join('');
  }

  function openQueryHistory() {
    renderQueryHistory();
    historyScrollTop = window.scrollY;
    $('vehicleHistoryOverlay').hidden = false;
    document.body.classList.add('vehicle-history-open');
  }

  function closeQueryHistory() {
    $('vehicleHistoryOverlay').hidden = true;
    document.body.classList.remove('vehicle-history-open');
    window.scrollTo(0, historyScrollTop);
  }

  function findHistoryEntry(id) {
    return queryHistory.find(entry => entry.id === id) || null;
  }

  function handleHistoryAction(event) {
    const button = event.target.closest('[data-history-action]');
    const card = event.target.closest('[data-history-id]');
    if (!button || !card) return;
    const entry = findHistoryEntry(card.dataset.historyId);
    if (!entry) return;
    const action = button.dataset.historyAction;
    if (action === 'delete') {
      queryHistory = queryHistory.filter(item => item.id !== entry.id);
      saveQueryHistory();
      renderQueryHistory();
      return;
    }
    if (action === 'rerun') return rerunHistoryEntry(entry);
    viewHistoryEntry(entry);
  }

  function setResultPageTitle(text) {
    const title = document.querySelector('.result-page-title');
    if (title) title.textContent = text || '查询结果';
  }

  function viewHistoryEntry(entry) {
    closeQueryHistory();
    $('hint').style.display = 'none';
    $('result').innerHTML = entry.resultHtml || '<p class="error-msg">该条历史没有可查看的结果快照</p>';
    setResultPageTitle('历史结果 · ' + formatHistoryOperationTime(entry.createdAt));
    if (typeof showResultPage === 'function') showResultPage();
    if (!document.body.classList.contains('result-page')) $('result').scrollIntoView({ block: 'start' });
  }

  function rerunHistoryEntry(entry) {
    closeQueryHistory();
    setResultPageTitle('查询结果');
    if (entry.serviceDate) selectedServiceDate = entry.serviceDate;
    refreshDateOptions();
    const dateOption = Array.from($('vehicleServiceDate').options).find(option => option.value === entry.serviceDate);
    if (dateOption) $('vehicleServiceDate').value = entry.serviceDate;
    if (typeof switchMode === 'function' && (entry.mode === 'weekday' || entry.mode === 'weekend')) switchMode(entry.mode);
    $('stationSelect').value = entry.station || '';
    $('stationHour').value = entry.hour || '';
    $('stationMinute').value = entry.minute || '';
    refreshVehicleOptions();
    activeVehicleQuery = entry.vehicle || '';
    lastResolvedTable = entry.table || '';
    $('tableInput').value = entry.raw || '';
    $('vehicleQuerySelect').value = '';
    hideVehicleResolution();
    enhancedQuery(true);
  }

  function clearQueryHistory() {
    if (!queryHistory.length) return;
    if (!window.confirm('清空全部查询历史？')) return;
    queryHistory = [];
    saveQueryHistory();
    renderQueryHistory();
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
    if (name === 'upload') {
      setRecognitionStatus(photos.length ? '已选择' + photos.length + '张照片。' : '请选择1至3张照片。');
      loadVehicleQuota();
      refreshHandwritingMemoryStatus();
    }
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
    $('vehicleRecognizeButton').disabled = !isSupportedPhotoCount(photos.length);
    if (files.length === 3) setRecognitionStatus('已选择3张照片，将完整识别并导入当天数据。', 'success');
    else if (files.length === 1) setRecognitionStatus('已选择1张照片；横向三表合拍图会自动拆分。若横图实际只有一张表，可在照片下方手动选择表号范围以按单张识别。', 'success');
    else if (files.length) setRecognitionStatus('已选择' + files.length + '张照片，将作为同一批次整体更新对应表号范围。', 'success');
    else setRecognitionStatus('请选择1至3张照片。', 'error');
  }

  function renderPhotoCards() {
    $('vehiclePhotoGrid').innerHTML = photos.map((photo, index) => {
      const detected = photo.detectedPageType ? pageTypeById(photo.detectedPageType) : null;
      const options = '<option value="">自动识别照片类型</option>' + PAGE_TYPES.map(page => '<option value="' + page.id + '"' + (photo.manualPageType === page.id ? ' selected' : '') + '>' + page.label + ' · ' + formatTable(page.start) + '—' + formatTable(page.end) + '表</option>').join('');
      const metadata = photo.recognizedDate
        ? '日期：' + formatDateLabel(photo.recognizedDate) + (photo.planCode ? ' · 标题：' + escapeHtml(photo.planCode) : '')
        : '等待识别日期与标题代号';
      return '<article class="vehicle-photo-card"><img src="' + photo.url + '" alt="第' + (index + 1) + '张运行计划"><div class="vehicle-photo-info"><strong>第' + (index + 1) + '张' + (photo.compositeCrop ? ' · 合拍裁片' : '') + (detected ? ' · 已识别' + detected.label : '') + '</strong><select class="vehicle-photo-page-select" data-photo-index="' + index + '">' + options + '</select><span class="vehicle-muted">' + metadata + '</span></div></article>';
    }).join('');
  }

  function setRecognitionStatus(message, type = '') {
    $('vehicleRecognitionStatus').textContent = message;
    $('vehicleRecognitionStatus').className = 'vehicle-status ' + type;
  }

  function showVehicleQuota(usage) {
    const quota = $('vehicleAiQuota');
    if (!quota || !usage) return;
    const required = ['device_used', 'device_limit', 'global_used', 'global_limit'];
    if (required.some(key => usage[key] === undefined || usage[key] === null)) return;
    const expiresAt = Number(usage.expires_at);
    const expiresText = Number.isFinite(expiresAt) && expiresAt > 0
      ? '令牌有效至 ' + new Date(expiresAt * 1000).toLocaleDateString('zh-CN') + '。'
      : '';
    quota.textContent = '今日本设备 ' + usage.device_used + '/' + usage.device_limit +
      ' 次；服务总计 ' + usage.global_used + '/' + usage.global_limit + ' 次。' +
      expiresText;
    quota.hidden = false;
  }

  async function loadVehicleQuota() {
    const quota = $('vehicleAiQuota');
    const base = String(localStorage.getItem('ts_worker') || '').replace(/\/+$/, '');
    const token = localStorage.getItem('ts_token') || '';
    if (!quota || !base || !token) {
      if (quota) quota.hidden = true;
      return;
    }
    try {
      const response = await fetch(base + '/me', {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!response.ok) return;
      showVehicleQuota(await response.json());
    } catch (_) {
      // 配额读取失败不应影响照片识别；识别成功后仍会使用响应中的 usage 更新。
    }
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

  function loadPhotoFileImage(file) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => resolve({ image, url });
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('照片读取失败'));
      };
      image.src = url;
    });
  }

  function canvasJpegBlob(canvas, quality = 0.92) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('合拍照片裁切失败')), 'image/jpeg', quality);
    });
  }

  function compositeCropRegions(width, height) {
    const segment = width / COMPOSITE_PAGE_COUNT;
    const overlap = segment * 0.075;
    const top = Math.max(0, Math.round(height * 0.12));
    return Array.from({ length: COMPOSITE_PAGE_COUNT }, (_, index) => {
      const left = Math.max(0, Math.floor(index * segment - (index ? overlap : 0)));
      const right = Math.min(width, Math.ceil((index + 1) * segment + (index < COMPOSITE_PAGE_COUNT - 1 ? overlap : 0)));
      return { left, top, width: right - left, height: height - top };
    });
  }

  async function splitCompositePhoto(photo) {
    const loaded = await loadPhotoFileImage(photo.file);
    const image = loaded.image;
    try {
      if (image.naturalWidth / Math.max(1, image.naturalHeight) < COMPOSITE_MIN_ASPECT_RATIO) return [];
      const regions = compositeCropRegions(image.naturalWidth, image.naturalHeight);
      const baseName = String(photo.file.name || '运行计划').replace(/\.[^.]+$/, '');
      const crops = [];
      for (let index = 0; index < regions.length; index += 1) {
        const region = regions[index];
        const scale = Math.max(1, Math.min(3, 2200 / region.height, 1400 / region.width));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(region.width * scale));
        canvas.height = Math.max(1, Math.round(region.height * scale));
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(
          image,
          region.left,
          region.top,
          region.width,
          region.height,
          0,
          0,
          canvas.width,
          canvas.height
        );
        const blob = await canvasJpegBlob(canvas);
        const file = new File([blob], baseName + '-自动裁片' + (index + 1) + '.jpg', { type: 'image/jpeg' });
        crops.push({
          file,
          url: URL.createObjectURL(file),
          index,
          manualPageType: '',
          detectedPageType: '',
          recognizedDate: '',
          planCode: '',
          result: null,
          compositeCrop: true
        });
      }
      return crops;
    } finally {
      URL.revokeObjectURL(loaded.url);
    }
  }

  async function expandCompositePhotoIfNeeded() {
    if (photos.length !== 1 || photos[0].manualPageType) return false;
    const original = photos[0];
    const crops = await splitCompositePhoto(original);
    if (crops.length !== COMPOSITE_PAGE_COUNT) return false;
    if (original.url) URL.revokeObjectURL(original.url);
    photos = crops;
    renderPhotoCards();
    return true;
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
    const partialUpdate = photos.length < PAGE_TYPES.length;
    const request = {
      task: 'daily_vehicle_mapping',
      images,
      handwriting_examples: requestHandwritingExamples(),
      provider: 'doubao',
      import_mode: partialUpdate ? 'partial_page_update' : 'full_day_import',
      existing_service_dates: Object.keys(store.days || {}),
      expected_pages: PAGE_TYPES.map(page => ({ id: page.id, label: page.label, table_start: page.start, table_end: page.end })),
      required_metadata: ['service_date', 'document_title', 'plan_code', 'schedule_type'],
      schedule_candidates: [
        { id: 'weekday', label: '平日图', title_codes: ['PR'], expected_tables: ALL_TABLES },
        { id: 'weekend', label: '双休日图', title_codes: ['SX'], compatible_title_codes: ['SGJR'], expected_tables: WEEKEND_TABLES }
      ],
      classification_rule: partialUpdate
        ? '逐张识别所选照片的日期、所属检修中心或主表号范围及全部有效车号；所选照片将作为同一批次覆盖该日期已有数据中的对应范围。'
        : '先逐张识别日期并确认三张日期一致，再综合标题代号与实际主表号数量判断平日图或双休日图；SGJR是中性代号，不得因其与SX不同而拒绝同日期照片。'
    };
    try {
      return await workerRequest('/recognize-vehicle-map', request);
    } catch (error) {
      if ([404, 405].includes(error.status)) {
        throw new Error('当前AI服务还没有车号识别接口，请先更新并部署 TrainSheet-AI 后再试');
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
    const value = String(response.schedule_type || response.plan_type || response.timetable_type || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
    if (['weekend', 'doubleholiday', 'doubleoff', '双休', '双休日', '节假日'].includes(value)) return 'weekend';
    if (['weekday', 'workday', '平日', '工作日'].includes(value)) return 'weekday';
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

  function conflictingStrongPlanCode(scheduleType, planCodes) {
    if (scheduleType === 'weekend') return planCodes.find(code => /^PR/.test(code)) || '';
    if (scheduleType === 'weekday') return planCodes.find(code => /^SX/.test(code)) || '';
    return '';
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
    return {
      rawRows,
      pageType: detectedPageType,
      date: recognizedDate,
      planCode,
      explicitScheduleType,
      imageIndex: photo.index + 1
    };
  }

  function normalizedRow(raw, pageType, imageIndex) {
    const table = formatTable(raw.table_no || raw.table || raw.tableNumber);
    const reportedChanged = formatVehicle(raw.changed_vehicle_number || raw.changed_train_number || raw.replacement_vehicle_number);
    const original = formatVehicle(raw.original_vehicle_number || raw.vehicle_number || raw.train_number);
    const reportedEffective = formatVehicle(raw.effective_vehicle_number || reportedChanged || original);
    const reportedDifferent = Boolean(reportedEffective && original && reportedEffective !== original);
    const claimsModification = Boolean(raw.vehicle_modified || raw.train_modified || reportedChanged || reportedDifferent);
    const sourceText = String(raw.change_source_zone || raw.source_zone || raw.vehicle_change_source || '').toLowerCase().replace(/[\s_-]+/g, '');
    const noneSources = new Set(['', 'none', 'nochange', '无', '未变更']);
    const mainSources = new Set([
      'main', 'primary', 'formal', 'target', 'maincell', 'primarycell', 'formalcell', 'targetcell',
      '正式', '正式栏', '正式格', '主表', '目标格', '目标区', '目标区内'
    ]);
    const otherSources = new Set([
      'other', 'secondary', 'reserve', 'inspection', 'note', 'othercell', 'secondarycell',
      '预备', '预备栏', '周检', '周检栏', '备注', '备注栏', '其他', '其他栏位', '非目标区'
    ]);
    const sourceZone = noneSources.has(sourceText)
      ? 'none'
      : mainSources.has(sourceText)
        ? 'main'
        : otherSources.has(sourceText)
          ? 'other'
          : 'uncertain';
    const changeInPrimaryCell = raw.change_in_primary_vehicle_cell === true
      || raw.modification_in_target_cell === true
      || raw.change_inside_target_cell === true;
    const trustedModification = claimsModification && sourceZone === 'main' && changeInPrimaryCell;
    const ignoredChanged = formatVehicle(raw.ignored_changed_vehicle_number)
      || (!trustedModification ? (reportedChanged || (reportedDifferent ? reportedEffective : '')) : '');
    const changed = trustedModification ? (reportedChanged || (reportedDifferent ? reportedEffective : '')) : '';
    const effective = trustedModification
      ? (reportedEffective || changed || original)
      : claimsModification
        ? original
        : (reportedEffective || original);
    const reasons = Array.isArray(raw.review_reasons) ? raw.review_reasons.slice() : [];
    const modified = trustedModification;
    const confidence = Number(raw.confidence == null ? 1 : raw.confidence);
    const changeCellBbox = normalizeCellBbox(raw.change_cell_bbox || raw.target_cell_bbox || raw.bbox);
    const noteParts = [];
    if (changed) noteParts.push('识别到变更车号' + changed);
    if (modified) noteParts.push('存在正式变更车号填写或手写划改');
    if (claimsModification && !trustedModification) {
      if (sourceZone === 'other' && !changeInPrimaryCell) {
        noteParts.push(ignoredChanged
          ? '同行其他栏位的疑似车号' + ignoredChanged + '已忽略'
          : '同行其他栏位的划改已忽略');
      } else if (!reasons.some(reason => /位置无法确认|已保留正式车号/.test(String(reason)))) {
        reasons.push(ignoredChanged
          ? '疑似变更车号' + ignoredChanged + '的位置无法确认，已保留正式车号'
          : '划改位置无法确认，已保留正式车号');
      }
    } else if (ignoredChanged) {
      noteParts.push('同行其他栏位的疑似车号' + ignoredChanged + '已忽略');
    }
    if (raw.ambiguity) noteParts.push('AI认为不确定');
    if (confidence < 0.88) noteParts.push('置信度较低');
    reasons.forEach(reason => noteParts.push(String(reason)));
    if (raw.note) noteParts.push(String(raw.note));
    return {
      table,
      vehicle: effective,
      modelVehicle: effective,
      originalVehicle: original,
      changedVehicle: changed,
      modelChangedVehicle: reportedChanged,
      pageType,
      imageIndex: Number(imageIndex) || 0,
      changeCellBbox,
      modelModified: modified,
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
      modelVehicle: '',
      originalVehicle: '',
      changedVehicle: '',
      modelChangedVehicle: '',
      pageType: page ? page.id : '',
      imageIndex: 0,
      changeCellBbox: [],
      modelModified: false,
      confidence: 0,
      needsReview: true,
      conflict: false,
      note,
      manuallyEdited: false
    };
  }

  function buildRecognizedReviewRows(results, scheduleType, preservedRows = [], pageTypes = []) {
    const rawByTable = new Map();
    results.forEach(result => {
      result.rawRows.forEach(raw => {
        const table = formatTable(raw.table_no || raw.table || raw.tableNumber);
        // 每张照片只能贡献本车辆段主表范围内的数据，避免把“预备”栏的
        // 01、13、14……误当成另一车辆段的正式表号。
        if (table && tableBelongsToPageType(table, result.pageType)) {
          rawByTable.set(table, { raw, pageType: result.pageType, imageIndex: result.imageIndex });
        }
      });
    });
    const preserved = new Map(preservedRows.filter(row => row.manuallyEdited).map(row => [row.table, row]));
    const requestedPages = new Set(pageTypes.filter(Boolean));
    const expectedTables = tablesForScheduleType(scheduleType).filter(table => {
      if (!requestedPages.size) return true;
      const page = pageTypeForTable(table);
      return Boolean(page && requestedPages.has(page.id));
    });
    return expectedTables.map(table => {
      const source = rawByTable.get(table);
      const row = source
        ? normalizedRow(source.raw, source.pageType || pageTypeForTable(table).id, source.imageIndex)
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
      ? buildRecognizedReviewRows(
          recognitionMeta.results,
          scheduleType,
          previous,
          isPartialImport() ? partialImportPageTypes() : []
        )
      : buildManualReviewRows(scheduleType, previous);
    revalidateReviewRows();
    renderReviewRows();
    renderReviewSummary();
  }

  function currentReviewScheduleType() {
    if (SCHEDULE_TYPES[recognitionMeta.scheduleType]) return recognitionMeta.scheduleType;
    const selected = $('vehicleReviewScheduleType') && $('vehicleReviewScheduleType').value;
    if (SCHEDULE_TYPES[selected]) return selected;
    return recognitionMeta.suggestedScheduleType;
  }

  function scopedReviewRows() {
    const scheduleType = currentReviewScheduleType();
    if (!SCHEDULE_TYPES[scheduleType]) return reviewRows.slice();
    const allowed = new Set(tablesForScheduleType(scheduleType));
    return reviewRows.filter(row => {
      if (!allowed.has(row.table)) return false;
      if (!isPartialImport()) return true;
      const selectedPages = new Set(partialImportPageTypes());
      const page = pageTypeForTable(row.table);
      return Boolean(page && selectedPages.has(page.id));
    });
  }

  function renderScheduleReview() {
    const select = $('vehicleReviewScheduleType');
    const evidence = $('vehicleScheduleEvidence');
    if (!select || !evidence) return;
    const partialUpdate = isPartialImport();
    const existingPartialDate = partialUpdate ? dayData(recognitionMeta.dates[0]) : null;
    select.disabled = Boolean(existingPartialDate);
    select.value = recognitionMeta.scheduleNeedsConfirmation && !recognitionMeta.scheduleManuallyConfirmed
      ? ''
      : recognitionMeta.scheduleType;
    const label = SCHEDULE_TYPES[recognitionMeta.suggestedScheduleType || recognitionMeta.scheduleType];
    const parts = [];
    if (reviewSource === 'photo') {
      if (partialUpdate) {
        const targetPages = partialImportPageTypes();
        const pageLabels = targetPages.map(pageType => pageTypeById(pageType)?.label).filter(Boolean).join('、');
        const affected = existingPartialDate
          ? mergeSelectedPageData(existingPartialDate, [], targetPages, recognitionMeta.scheduleType).removedAdjustments.length
          : 0;
        if (existingPartialDate) {
          parts.push('局部更新：沿用当天“' + (SCHEDULE_TYPES[recognitionMeta.scheduleType] || SCHEDULE_TYPES.weekday).label + '”，将' + targetPages.length + '张照片作为一个批次，整体覆盖' + (pageLabels || '已识别') + '的表号范围。');
        } else {
          parts.push(recognitionMeta.scheduleNeedsConfirmation && !recognitionMeta.scheduleManuallyConfirmed
            ? '首次局部导入：AI倾向“' + (label ? label.label : '未知类型') + '”，请确认后建立部分数据。'
            : '首次局部导入：已判定为“' + (SCHEDULE_TYPES[recognitionMeta.scheduleType] || SCHEDULE_TYPES.weekday).label + '”，将建立' + (pageLabels || '所选照片') + '的部分数据。');
        }
        if (affected) parts.push('保存时将移除' + affected + '条涉及该范围的旧换表记录，其他换表记录不受影响。');
      } else {
        parts.push(recognitionMeta.scheduleNeedsConfirmation && !recognitionMeta.scheduleManuallyConfirmed
          ? 'AI倾向“' + (label ? label.label : '未知类型') + '”，但证据存在冲突，请人工选择后再保存。'
          : '已判定为“' + (SCHEDULE_TYPES[recognitionMeta.scheduleType] || SCHEDULE_TYPES.weekday).label + '”。');
      }
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
    if (!isSupportedPhotoCount(photos.length)) return setRecognitionStatus('请选择1至3张照片。', 'error');
    $('vehicleRecognizeButton').disabled = true;
    $('vehicleRecognitionProgress').classList.add('active');
    setRecognitionStatus('正在准备' + photos.length + '张照片……');
    try {
      const compositeExpanded = await expandCompositePhotoIfNeeded();
      const partialUpdate = photos.length < PAGE_TYPES.length;
      setRecognitionStatus(compositeExpanded
        ? '已将横向合拍照片拆分为3张高清裁片，正在识别日期、范围和车号……'
        : '正在一次识别' + photos.length + '张照片的日期、范围和车号，请稍候……');
      const response = await recognizePhotoBatch();
      showVehicleQuota(response.usage);
      const responsePages = Array.isArray(response.pages) ? response.pages : [];
      const results = photos.map((photo, index) => {
        const pageResponse = responsePages.find(page => Number(page.image_index) === index + 1) || responsePages[index] || (photos.length === 1 ? response : {});
        return normalizeRecognition(photo, pageResponse, response);
      });
      const pageTypes = results.map(result => result.pageType);
      const missingType = pageTypes.findIndex(type => !type);
      if (missingType >= 0) throw new Error('第' + (missingType + 1) + '张照片无法自动判断表号范围，请在照片下方手工选择后重新识别');
      if (new Set(pageTypes).size !== photos.length) throw new Error('检测到重复的检修中心照片，请检查所选照片类型后重新识别');
      const dates = results.map(result => result.date).filter(Boolean);
      const dateConflict = Boolean(response.date_conflict) || new Set(dates).size > 1;
      const dateReady = dates.length === photos.length && !dateConflict;
      const recognizedDate = dateReady ? dates[0] : '';
      if (partialUpdate) {
        if (!dateReady) throw new Error('局部更新的所有照片必须识别出同一个明确日期，请检查后重试');
        const existing = dayData(recognizedDate);
        const pages = pageTypes.map(pageTypeById).filter(Boolean);
        const pageLabels = pages.map(page => page.label).join('、');
        const observedInference = inferScheduleType(recognizedDate, results, response);
        const existingScheduleType = existing ? dayScheduleType(existing, recognizedDate) : '';
        const conflictingCode = existing ? conflictingStrongPlanCode(existingScheduleType, observedInference.planCodes) : '';
        if (conflictingCode) {
          throw new Error('照片日期与已导入数据相同，但标题代号' + conflictingCode + '与当天的“' + SCHEDULE_TYPES[existingScheduleType].label + '”冲突，请检查是否选错照片');
        }
        const scheduleInference = existing
          ? {
              type: existingScheduleType,
              needsConfirmation: false,
              evidence: ['已匹配' + formatDateLabel(recognizedDate) + '的现有数据', '识别为' + pageLabels + '表号范围'],
              conflicts: [],
              planCodes: observedInference.planCodes
            }
          : observedInference;
        if (!existing) scheduleInference.evidence.unshift('这是该日期首次局部导入，将建立所选范围的数据');
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
          planCodes: scheduleInference.planCodes,
          importMode: 'partial',
          targetPageType: pageTypes.length === 1 ? pageTypes[0] : '',
          targetPageTypes: pageTypes
        };
        reviewRows = buildRecognizedReviewRows(results, scheduleInference.type, [], pageTypes);
      } else {
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
          planCodes: scheduleInference.planCodes,
          importMode: 'full'
        };
        reviewRows = buildRecognizedReviewRows(results, scheduleInference.type);
      }
      reviewSource = 'photo';
      $('vehicleManualDateField').hidden = true;
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
      $('vehicleRecognizeButton').disabled = !isSupportedPhotoCount(photos.length);
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
      row.conflictTables = [];
    });
    scopedReviewRows().forEach(row => {
      const vehicle = formatVehicle(row.vehicle);
      if (!vehicle) return;
      if (!vehicles.has(vehicle)) vehicles.set(vehicle, []);
      vehicles.get(vehicle).push(row);
    });
    vehicles.forEach(rows => {
      if (rows.length > 1) rows.forEach(row => {
        row.conflict = true;
        row.conflictTables = rows.filter(peer => peer !== row).map(peer => peer.table);
      });
    });
    if (isPartialImport()) {
      const existing = dayData(recognitionMeta.dates[0]);
      const selectedPages = new Set(partialImportPageTypes());
      const targetTables = new Set(tablesForScheduleType(recognitionMeta.scheduleType).filter(table => {
        const page = pageTypeForTable(table);
        return Boolean(page && selectedPages.has(page.id));
      }));
      const outsideVehicles = new Map();
      Object.entries((existing && existing.base) || {}).forEach(([tableValue, vehicleValue]) => {
        const table = formatTable(tableValue);
        const vehicle = formatVehicle(vehicleValue);
        if (!table || !vehicle || targetTables.has(table)) return;
        if (!outsideVehicles.has(vehicle)) outsideVehicles.set(vehicle, []);
        outsideVehicles.get(vehicle).push(table);
      });
      scopedReviewRows().forEach(row => {
        const duplicateTables = outsideVehicles.get(formatVehicle(row.vehicle)) || [];
        if (!duplicateTables.length) return;
        row.conflict = true;
        row.conflictTables = row.conflictTables.concat(duplicateTables);
      });
    }
    reviewRows.forEach(row => {
      row.conflictTables = [...new Set(row.conflictTables || [])]
        .filter(table => table !== row.table)
        .sort((a, b) => Number(a) - Number(b));
    });
  }

  function reviewRowNote(row) {
    let note = row.note;
    if (row.conflict) {
      const vehicle = formatVehicle(row.vehicle);
      const tables = (row.conflictTables || []).map(table => table + '号表').join('、');
      note = tables
        ? '车号' + vehicle + '与' + tables + '重复，必须修改'
        : '车号' + vehicle + '重复，必须修改';
    }
    if (!row.vehicle) note = note ? note + '；车号为空' : '车号为空';
    return note;
  }

  function refreshRenderedReviewValidation() {
    scopedReviewRows().forEach(row => {
      const input = document.querySelector('[data-review-table="' + row.table + '"]');
      if (!input) return;
      const tableRow = input.closest('tr');
      const note = tableRow && tableRow.querySelector('.vehicle-row-note');
      const flagged = row.needsReview || row.conflict || !formatVehicle(row.vehicle);
      if (tableRow) {
        tableRow.classList.toggle('needs-review', flagged);
        tableRow.classList.toggle('conflict', row.conflict);
        tableRow.classList.toggle('hidden-row', reviewFilter === 'flagged' && !flagged);
      }
      if (note) {
        note.textContent = reviewRowNote(row);
        note.classList.toggle('alert', flagged);
      }
    });
  }

  function renderReviewRows() {
    revalidateReviewRows();
    const visibleRows = scopedReviewRows();
    $('vehicleReviewBody').innerHTML = visibleRows.map(row => {
      const flagged = row.needsReview || row.conflict || !formatVehicle(row.vehicle);
      const hidden = reviewFilter === 'flagged' && !flagged;
      const classes = [flagged ? 'needs-review' : '', row.conflict ? 'conflict' : '', hidden ? 'hidden-row' : ''].filter(Boolean).join(' ');
      const note = reviewRowNote(row);
      return '<tr class="' + classes + '"><td><strong>' + row.table + '号表</strong></td><td><input data-review-table="' + row.table + '" value="' + escapeHtml(row.vehicle) + '" maxlength="3" inputmode="numeric" aria-label="' + row.table + '号表最终车号"></td><td><div class="vehicle-row-note ' + (flagged ? 'alert' : '') + '">' + escapeHtml(note) + '</div></td></tr>';
    }).join('');
  }

  function renderReviewSummary() {
    const visibleRows = scopedReviewRows();
    const flagged = visibleRows.filter(row => row.needsReview || row.conflict || !formatVehicle(row.vehicle)).length;
    const conflicts = visibleRows.filter(row => row.conflict).length;
    const filled = visibleRows.filter(row => formatVehicle(row.vehicle)).length;
    const pageLabels = partialImportPageTypes().map(pageType => pageTypeById(pageType)?.label).filter(Boolean).join('、');
    const partialPrefix = isPartialImport() ? '局部更新' + pageLabels + '范围：' : '';
    $('vehicleReviewSummary').textContent = partialPrefix + '共' + visibleRows.length + '个表号，已填写' + filled + '个；' + flagged + '行需要确认，' + conflicts + '行涉及重复冲突。所有车号均可直接修改。';
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
      status.textContent = '照片日期不一致，禁止保存';
      status.classList.add('error');
      return;
    }
    const expectedDates = recognitionMeta.pageTypes.length || 3;
    if (recognitionMeta.dates.length !== expectedDates) {
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

  function loadPhotoImage(photo) {
    return new Promise((resolve, reject) => {
      if (!photo || !photo.url) return reject(new Error('原照片已释放'));
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('无法读取原照片'));
      image.src = photo.url;
    });
  }

  async function cropHandwritingCell(photo, bbox) {
    const box = normalizeCellBbox(bbox);
    if (!box.length) return '';
    const image = await loadPhotoImage(photo);
    const rawX1 = image.naturalWidth * box[0] / 1000;
    const rawY1 = image.naturalHeight * box[1] / 1000;
    const rawX2 = image.naturalWidth * box[2] / 1000;
    const rawY2 = image.naturalHeight * box[3] / 1000;
    const rawWidth = rawX2 - rawX1;
    const rawHeight = rawY2 - rawY1;
    const marginX = Math.max(3, rawWidth * 0.08);
    const marginY = Math.max(3, rawHeight * 0.12);
    const sx = Math.max(0, rawX1 - marginX);
    const sy = Math.max(0, rawY1 - marginY);
    const sw = Math.min(image.naturalWidth - sx, rawWidth + marginX * 2);
    const sh = Math.min(image.naturalHeight - sy, rawHeight + marginY * 2);
    if (sw < 8 || sh < 8) return '';
    const scale = Math.max(1, Math.min(3, 420 / sw, 220 / sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    let quality = 0.88;
    let data = canvas.toDataURL('image/jpeg', quality);
    while (data.length > 220000 && quality > 0.64) {
      quality -= 0.06;
      data = canvas.toDataURL('image/jpeg', quality);
    }
    return data.length <= 220000 ? data : '';
  }

  async function rememberReviewedHandwriting(rowsToSave) {
    if (reviewSource !== 'photo' || !photos.length) return 0;
    const candidates = rowsToSave.filter(row => {
      const confirmed = formatVehicle(row.vehicle);
      const modelValue = formatVehicle(row.modelVehicle);
      return row.manuallyEdited && confirmed && confirmed !== modelValue &&
        row.modelModified && normalizeCellBbox(row.changeCellBbox).length && row.imageIndex > 0;
    });
    const learned = [];
    for (const row of candidates.slice(0, 8)) {
      try {
        const image = await cropHandwritingCell(photos[row.imageIndex - 1], row.changeCellBbox);
        if (!image) continue;
        learned.push({
          image,
          confirmed_value: formatVehicle(row.vehicle),
          original_value: formatVehicle(row.originalVehicle),
          model_value: formatVehicle(row.modelChangedVehicle),
          created_at: new Date().toISOString()
        });
      } catch (_) {
        // 笔迹样本保存失败不能阻止当天车号数据导入。
      }
    }
    if (learned.length) saveHandwritingExamples(learned);
    return learned.length;
  }

  async function saveReviewedImport() {
    setReviewStatus('');
    const scheduleType = $('vehicleReviewScheduleType').value;
    if (!SCHEDULE_TYPES[scheduleType]) return setReviewStatus('请先人工确认本次是平日图还是双休日图。', 'error');
    recognitionMeta.scheduleType = scheduleType;
    revalidateReviewRows();
    const allowedTables = new Set(tablesForScheduleType(scheduleType));
    const selectedPages = new Set(partialImportPageTypes());
    const rowsToSave = reviewRows.filter(row => allowedTables.has(row.table) && (
      !isPartialImport() || selectedPages.has(pageTypeForTable(row.table)?.id)
    ));
    const duplicateRows = rowsToSave.filter(row => row.conflict);
    if (duplicateRows.length) return setReviewStatus('仍有重复车号，请修改后再保存。', 'error');
    const expectedDates = recognitionMeta.pageTypes.length || 3;
    if (reviewSource === 'photo' && recognitionMeta.dateConflict) return setReviewStatus('照片日期不一致，不能保存。', 'error');
    if (reviewSource === 'photo' && recognitionMeta.dates.length !== expectedDates) return setReviewStatus('有照片未识别到日期，不能保存，请重新拍摄或重新识别。', 'error');
    const date = reviewSource === 'photo' ? recognitionMeta.dates[0] : $('vehicleImportDate').value;
    if (!recentDates().includes(date)) return setReviewStatus('运行日期不在当前可保存范围内。', 'error');
    const filledRows = rowsToSave.filter(row => formatVehicle(row.vehicle));
    if (!filledRows.length) return setReviewStatus('当前照片范围至少需要填写一条表号和车号对应关系。', 'error');
    let candidate;
    if (isPartialImport()) {
      const existing = dayData(date);
      const baseData = existing || { date, base: {}, adjustments: [] };
      const targetPageTypes = partialImportPageTypes();
      const merged = mergeSelectedPageData(baseData, rowsToSave, targetPageTypes, scheduleType);
      const importedPages = Object.fromEntries(importedPageTypes(existing).map(pageType => [pageType, true]));
      targetPageTypes.forEach(pageType => { importedPages[pageType] = true; });
      const complete = PAGE_TYPES.every(page => importedPages[page.id]);
      const now = new Date().toISOString();
      candidate = Object.assign({}, baseData, {
        date,
        base: merged.base,
        adjustments: merged.adjustments,
        scheduleType,
        importedPages,
        scheduleEvidence: [...new Set((baseData.scheduleEvidence || []).concat(recognitionMeta.scheduleEvidence || []))],
        planCodes: [...new Set((baseData.planCodes || []).concat(recognitionMeta.planCodes || []))],
        importedAt: baseData.importedAt || now,
        updatedAt: now,
        source: complete ? 'ai-photo-incremental-complete' : 'ai-photo-partial-update',
        lastPartialUpdate: {
          pageType: targetPageTypes.length === 1 ? targetPageTypes[0] : '',
          pageTypes: targetPageTypes,
          removedAdjustmentCount: merged.removedAdjustments.length,
          updatedAt: now
        }
      });
    } else {
      const base = {};
      filledRows.forEach(row => { base[row.table] = formatVehicle(row.vehicle); });
      candidate = {
        date,
        base,
        adjustments: [],
        scheduleType,
        importedPages: Object.fromEntries(PAGE_TYPES.map(page => [page.id, true])),
        scheduleEvidence: recognitionMeta.scheduleEvidence.slice(),
        planCodes: recognitionMeta.planCodes.slice(),
        importedAt: new Date().toISOString(),
        source: reviewSource === 'photo' ? 'ai-photo-review' : 'manual'
      };
    }
    const errors = validateDayTimeline(candidate);
    if (errors.length) return setReviewStatus('不能保存：' + errors.join('；'), 'error');
    const learnedCount = await rememberReviewedHandwriting(rowsToSave);
    store.days[date] = candidate;
    saveStore();
    selectedServiceDate = date;
    revokePhotos();
    setReviewStatus('已保存。' + (learnedCount ? '同时在本机记录了' + learnedCount + '条局部笔迹样本。' : ''), 'success');
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
    $('vehicleReimportButton').textContent = importedPageCount(data) < PAGE_TYPES.length ? '继续导入照片' : '重新识别照片';
    $('vehicleManageSummary').textContent = formatDateLabel(selectedServiceDate) + ' · ' + SCHEDULE_TYPES[scheduleType].label + ' · ' + importProgressText(data) + '：' + Object.keys(data.base || {}).length + '条初始对应，' + (data.adjustments || []).length + '次运行中调整。';
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
      tablesForScheduleType,
      tablesForPageType,
      isSupportedPhotoCount,
      mergeSelectedPageData,
      importedPageTypes,
      importedPageCount,
      isTablePageImported,
      conflictingStrongPlanCode,
      importProgressText
    };
  }

  cleanupStore();
  saveStore();
  buildInterface();
  queueDecorate();
}());
