/**
 * content/content.js
 * Injected floating dashboard overlay inside meeting pages.
 * Handles dragging, live transcription updates, control messaging, and structured summaries.
 */

(function () {
  // Prevent duplicate injections
  if (document.getElementById('gemini-scribe-root')) return;

  // State Management
  let activeState = 'IDLE'; // IDLE | RECORDING | SUMMARIZING | COMPLETED | ERROR
  let activeTab = 'TRANSCRIPT'; // TRANSCRIPT | SUMMARY
  let captureMode = 'websocket'; // 'websocket' | 'gmeet'
  let uiLanguage = 'vi'; // 'vi' | 'en'
  let isMinimized = false;
  let dragOffset = { x: 0, y: 0 };
  let isDragging = false;
  let wasDragged = false;
  let overlayEl = null;
  let gmeetObserver = null; // MutationObserver for Google Meet captions
  let lastCaptionTexts = new Map(); // Track last known text per speaker block to detect changes

  // Magic Pencil State Management
  let currentCropCleanup = null;
  let activeCropToolbar = null;

  // Context validity helper to catch extension reloads gracefully
  function checkContextValidity() {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id || !chrome.storage) {
        handleInvalidatedContext();
        return false;
      }
      return true;
    } catch (e) {
      handleInvalidatedContext();
      return false;
    }
  }

  function handleInvalidatedContext() {
    if (!overlayEl) return;
    if (overlayEl.querySelector('.scribe-context-invalidated')) return;
    
    isMinimized = false;
    overlayEl.className = 'gemini-scribe-overlay context-invalidated-wrapper';
    overlayEl.style.height = 'auto';
    overlayEl.style.width = '290px';
    overlayEl.style.minHeight = '0px';
    overlayEl.innerHTML = `
      <div class="scribe-context-invalidated" style="padding: 16px; text-align: center; font-family: system-ui, -apple-system, sans-serif; background: #202124; border: 1px solid #ea4335; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); color: #e8eaed;">
        <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
        <h4 style="margin: 0 0 8px 0; font-size: 14px; color: #ea4335; font-weight: 600;">Extension Context Invalidated</h4>
        <p style="margin: 0 0 12px 0; font-size: 12px; color: #9aa0a6; line-height: 1.4; text-align: left;">
          Extension đã được reload/cập nhật. Vui lòng nhấn nút dưới đây hoặc bấm F5 để tải lại trang cuộc họp và tiếp tục sử dụng.
        </p>
        <button id="scribe-reload-tab-btn" style="background: #ea4335; border: none; color: white; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; width: 100%;">
          Tải lại trang cuộc họp (F5)
        </button>
      </div>
    `;
    
    // Wire reload action directly
    const reloadBtn = overlayEl.querySelector('#scribe-reload-tab-btn');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', () => {
        window.location.reload();
      });
    }
    
    overlayEl.onclick = null;
  }

  // Initialize UI
  initScribeUI();

  /**
   * Main setup script to build and inject the floating CSS card.
   */
  function initScribeUI() {
    overlayEl = document.createElement('div');
    overlayEl.id = 'gemini-scribe-root';
    overlayEl.className = 'gemini-scribe-overlay';
    
    // Default starting position
    overlayEl.style.top = '100px';
    overlayEl.style.right = '24px';

    document.body.appendChild(overlayEl);

    // Initial state loading
    if (!checkContextValidity()) return;
    chrome.storage.local.get(['recordingState', 'recordingError', 'finalSummary', 'captureMode', 'uiLanguage'], (data) => {
      activeState = data.recordingState || 'IDLE';
      captureMode = data.captureMode || 'websocket';
      uiLanguage = data.uiLanguage || 'vi';
      const errorMsg = data.recordingError;
      const cachedSummary = data.finalSummary;

      renderPanelLayout();
      updateStateView(activeState, errorMsg, cachedSummary);
    });

    // Setup drag events
    setupDragging();
  }

  /**
   * Drag handle controller to relocate floating component.
   */
  function setupDragging() {
    let dragStartX = 0;
    let dragStartY = 0;

    const startDrag = (e) => {
      // Allow only left click dragging
      if (e.button !== 0) return;

      if (isMinimized) {
        // If minimized, dragging is allowed anywhere on miniView
        if (!e.target.closest('.scribe-minimized-view')) return;
      } else {
        // If full view, dragging is allowed only on the header, excluding buttons
        if (!e.target.closest('.scribe-header')) return;
        if (e.target.closest('.scribe-btn-header')) return;
      }

      isDragging = true;
      wasDragged = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragOffset.x = e.clientX - overlayEl.offsetLeft;
      dragOffset.y = e.clientY - overlayEl.offsetTop;
      
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', stopDrag);
      
      // Prevent text selection during drag
      e.preventDefault();
    };

    // Attach dragging to the main overlay element (delegated)
    overlayEl.addEventListener('mousedown', startDrag);

    function onDrag(e) {
      if (!isDragging) return;

      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        wasDragged = true;
      }
      
      // Keep inside boundary margins
      let x = e.clientX - dragOffset.x;
      let y = e.clientY - dragOffset.y;

      const rightEdge = window.innerWidth - overlayEl.offsetWidth;
      const bottomEdge = window.innerHeight - overlayEl.offsetHeight;

      x = Math.max(10, Math.min(x, rightEdge - 10));
      y = Math.max(10, Math.min(y, bottomEdge - 10));

      overlayEl.style.left = `${x}px`;
      overlayEl.style.top = `${y}px`;
      overlayEl.style.right = 'auto'; // Break initial right alignment
    }

    function stopDrag() {
      isDragging = false;
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', stopDrag);
    }
  }

  /**
   * Generates whole inner HTML of floating panel based on minimize state.
   */
  function renderPanelLayout() {
    const t = {
      vi: {
        captureMode: '📡 Nguồn ghi âm',
        wsMode: '🎙️ Bằng Giọng Nói',
        gmeetMode: '📋 Bằng Phụ Đề (Google meet)',
        startRec: '🔴 Bắt đầu Ghi',
        stopRec: '⏹️ Dừng & Tóm tắt',
        cancelRec: '❌ Hủy bỏ',
        pauseRec: '⏸️ Tạm dừng',
        resumeRec: '▶️ Tiếp tục',
        exportLabel: '📥 Xuất dữ liệu nhật ký:',
        liveLogs: 'Nhật ký Trực tiếp',
        aiSummary: 'Tóm tắt AI',
        noLogs: 'Chưa có bản ghi âm. Nhấn Bắt đầu để bắt đầu thu.',
        noReports: 'Chưa có báo cáo thông minh. Hoàn thành phiên ghi âm để tạo báo cáo.'
      },
      en: {
        captureMode: '📡 Capture Mode',
        wsMode: '🎙️ Voice (WebSocket STT)',
        gmeetMode: '📋 Captions (Google Meet)',
        startRec: '🔴 Start Recording',
        stopRec: '⏹️ Stop & Summary',
        cancelRec: '❌ Cancel',
        pauseRec: '⏸️ Pause',
        resumeRec: '▶️ Resume',
        exportLabel: '📥 Export transcript logs:',
        liveLogs: 'Live Logs',
        aiSummary: 'AI Summary',
        noLogs: 'No audio transcribed yet. Click Start to begin capturing.',
        noReports: 'No intelligence reports compiled yet. Complete a recording session to generate reports.'
      }
    }[uiLanguage] || t['vi'];

    const miniDisplay = isMinimized ? 'display: flex;' : 'display: none;';
    const fullDisplay = isMinimized ? 'display: none;' : 'display: flex;';

    overlayEl.className = isMinimized ? 'gemini-scribe-overlay minimized' : 'gemini-scribe-overlay';
    overlayEl.onclick = null; // We handle minimize internally

    overlayEl.innerHTML = `
      <!-- Minimized view -->
      <div class="scribe-minimized-view" title="Gemini Scribe Dashboard" style="${miniDisplay} width: 100%; height: 100%; justify-content: center; align-items: center; border-radius: 50%; cursor: pointer;">
        <div class="scribe-logo" style="font-size: 24px;">✨</div>
      </div>

      <!-- Full view -->
      <div class="scribe-full-view" style="${fullDisplay} flex-direction: column; width: 100%; max-height: inherit; flex-grow: 1;">
        <!-- Draggable Header -->
        <header class="scribe-header">
          <div class="scribe-header-title">
            <span class="scribe-logo">✨</span>
            <span class="scribe-title-text">Gemini Scribe</span>
          </div>
          <div class="scribe-header-actions">
            <button class="scribe-btn-header" id="scribe-magic-btn" title="Magic Pencil">🪄</button>
            <button class="scribe-btn-header" id="scribe-minimize-btn" title="Minimize Panel">➖</button>
          </div>
        </header>

        <!-- Main Body panel -->
        <div class="scribe-body">
          <!-- Capture Mode Selector -->
          <div style="padding: 16px 20px 4px 20px;">
            <div class="scribe-mode-selector">
              <label class="scribe-mode-label">${t.captureMode}</label>
              <select id="scribe-capture-mode" class="scribe-mode-dropdown">
                <option value="websocket">${t.wsMode}</option>
                <option value="gmeet">${t.gmeetMode}</option>
              </select>
            </div>
          </div>

          <!-- Control buttons row -->
          <div style="padding: 8px 20px 8px 20px;">
            <div class="scribe-actions-row">
              <button id="scribe-start-btn" class="scribe-btn scribe-btn-start">${t.startRec}</button>
              <button id="scribe-stop-btn" class="scribe-btn scribe-btn-stop" disabled>${t.stopRec}</button>
              <button id="scribe-pause-btn" class="scribe-btn scribe-btn-pause" style="display: none;">${t.pauseRec}</button>
              <button id="scribe-cancel-btn" class="scribe-btn scribe-btn-cancel" style="display: none; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5;">${t.cancelRec}</button>
            </div>
          </div>

          <!-- Navigation Tabs -->
          <nav class="scribe-tabs">
            <div class="scribe-tab active" id="scribe-tab-transcript">${t.liveLogs}</div>
            <div class="scribe-tab" id="scribe-tab-summary">${t.aiSummary}</div>
          </nav>

          <!-- Dynamic Panels -->
          <div class="scribe-panel-content" id="scribe-panel-transcript">
            <div class="scribe-transcript-box" id="scribe-live-box" style="height: 330px;">
              <div class="scribe-transcript-empty">${t.noLogs}</div>
            </div>
            <!-- Export Logs Actions -->
            <div class="scribe-export-logs-row" id="scribe-export-logs-row" style="display: none; padding: 12px 20px 0 20px;">
              <label class="scribe-export-label">${t.exportLabel}</label>
              <div class="scribe-export-buttons">
                <button class="scribe-export-log-btn" data-format="txt">📄 TXT</button>
                <button class="scribe-export-log-btn" data-format="doc">📎 DOC</button>
                <button class="scribe-export-log-btn" data-format="docx">📘 DOCX</button>
                <button class="scribe-export-log-btn" data-format="pdf">📕 PDF</button>
              </div>
            </div>
          </div>

          <div class="scribe-panel-content hidden" id="scribe-panel-summary">
            <!-- Summary Container -->
            <div id="scribe-summary-view" class="scribe-summary-box">
              <div class="scribe-transcript-empty">${t.noReports}</div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Hook DOM controllers
    setupControllers();
  }

  /**
   * Hook click and switch event handlers to visual components.
   */
  function setupControllers() {
    const minimizeBtn = document.getElementById('scribe-minimize-btn');
    const magicBtn = document.getElementById('scribe-magic-btn');
    const startBtn = document.getElementById('scribe-start-btn');
    const stopBtn = document.getElementById('scribe-stop-btn');
    const tabTranscript = document.getElementById('scribe-tab-transcript');
    const tabSummary = document.getElementById('scribe-tab-summary');
    const modeSelect = document.getElementById('scribe-capture-mode');

    if (magicBtn) {
      magicBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startMagicPencilFlow();
      });
    }

    // Restore saved capture mode
    modeSelect.value = captureMode;

    // Mode change event
    modeSelect.addEventListener('change', (e) => {
      captureMode = e.target.value;
      if (checkContextValidity()) {
        chrome.storage.local.set({ captureMode: captureMode });
      }
      console.log('[Scribe] Capture mode switched to:', captureMode);
    });

    // Minimize toggle function
    function setMinimizedState(minimized) {
      if (!checkContextValidity()) return;
      isMinimized = minimized;
      const miniView = overlayEl.querySelector('.scribe-minimized-view');
      const fullView = overlayEl.querySelector('.scribe-full-view');
      
      if (minimized) {
        overlayEl.classList.add('minimized');
        if (fullView) fullView.style.display = 'none';
        if (miniView) miniView.style.display = 'flex';
      } else {
        overlayEl.classList.remove('minimized');
        if (fullView) fullView.style.display = 'flex';
        if (miniView) miniView.style.display = 'none';
        
        // Auto-scroll transcript box to bottom on unminimize
        const liveBox = document.getElementById('scribe-live-box');
        if (liveBox) {
          liveBox.scrollTop = liveBox.scrollHeight;
        }
      }
    }

    // Minimize event
    minimizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMinimizedState(true);
    });

    const miniView = overlayEl.querySelector('.scribe-minimized-view');
    if (miniView) {
      miniView.addEventListener('click', (e) => {
        e.stopPropagation();
        if (wasDragged) {
          wasDragged = false;
          return;
        }
        setMinimizedState(false);
      });
    }

    // Tab switching
    tabTranscript.addEventListener('click', () => switchTab('TRANSCRIPT'));
    tabSummary.addEventListener('click', () => switchTab('SUMMARY'));

    // Recording start call
    startBtn.addEventListener('click', () => {
      if (captureMode === 'gmeet') {
        // Google Meet caption scraping mode
        startBtn.disabled = true;
        stopBtn.disabled = false;
        if (checkContextValidity()) {
          chrome.storage.local.set({ gmeetCaptions: {} }, () => {
            startGmeetCaptionObserver();
            updateStateView('RECORDING');
          });
        }
        return;
      }

      // Default WebSocket STT mode
      if (!checkContextValidity()) return;
      startBtn.disabled = true;
      chrome.runtime.sendMessage({ action: 'START_RECORDING_REQUEST' }, (response) => {
        if (!response || !response.success) {
          showErrorPanel(response?.error || 'Failed to initialize system tab capture.');
        }
      });
    });

    // Recording stop call
    stopBtn.addEventListener('click', () => {
      if (captureMode === 'gmeet') {
        // Stop Google Meet observer
        stopGmeetCaptionObserver();
        startBtn.disabled = false;
        stopBtn.disabled = true;
        // Trigger summarization if context is valid
        if (checkContextValidity()) {
          chrome.runtime.sendMessage({ action: 'STOP_RECORDING_REQUEST' }, (response) => {
            if (!response || !response.success) {
              showErrorPanel(response?.error || 'Summarization execution pipeline error.');
            }
          });
        }
        return;
      }

      if (!checkContextValidity()) return;
      stopBtn.disabled = true;
      chrome.runtime.sendMessage({ action: 'STOP_RECORDING_REQUEST' }, (response) => {
        if (!response || !response.success) {
          showErrorPanel(response?.error || 'Summarization execution pipeline error.');
        }
      });
    });

    // Recording cancel call
    const cancelBtn = document.getElementById('scribe-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (captureMode === 'gmeet') {
          // Stop Google Meet observer
          stopGmeetCaptionObserver();
        }

        if (!checkContextValidity()) return;

        // Immediately disable action controls
        startBtn.disabled = true;
        stopBtn.disabled = true;
        cancelBtn.disabled = true;

        chrome.runtime.sendMessage({ action: 'CANCEL_RECORDING_REQUEST' }, (response) => {
          startBtn.disabled = false;
          stopBtn.disabled = true;
          cancelBtn.disabled = false;
          cancelBtn.style.display = 'none';

          // Reset logs panel
          const liveBox = document.getElementById('scribe-live-box');
          if (liveBox) {
            liveBox.innerHTML = '<div class="scribe-transcript-empty">Recording cancelled. Click Start to begin capturing.</div>';
          }
          
          // Re-evaluate export buttons visibility
          updateExportLogsVisibility();
        });
      });
    }

    // Pause / Resume recording call
    const pauseBtn = document.getElementById('scribe-pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        if (!checkContextValidity()) return;
        
        if (activeState === 'RECORDING') {
          chrome.runtime.sendMessage({ action: 'PAUSE_RECORDING_REQUEST' }, (response) => {
            if (!response || !response.success) {
              console.error('Pause request failed:', response?.error);
            }
          });
        } else if (activeState === 'PAUSED') {
          chrome.runtime.sendMessage({ action: 'RESUME_RECORDING_REQUEST' }, (response) => {
            if (!response || !response.success) {
              console.error('Resume request failed:', response?.error);
            }
          });
        }
      });
    }

    // Export log buttons click event
    const exportRow = document.getElementById('scribe-export-logs-row');
    if (exportRow) {
      const exportBtns = exportRow.querySelectorAll('.scribe-export-log-btn');
      exportBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const format = btn.getAttribute('data-format');
          exportTranscriptData(format);
        });
      });
    }
  }

  /**
   * Switches visual panel display tags.
   */
  function switchTab(tab) {
    activeTab = tab;
    const tabTranscript = document.getElementById('scribe-tab-transcript');
    const tabSummary = document.getElementById('scribe-tab-summary');
    const panelTranscript = document.getElementById('scribe-panel-transcript');
    const panelSummary = document.getElementById('scribe-panel-summary');

    if (!tabTranscript) return; // Prevent crash if minimized

    if (tab === 'TRANSCRIPT') {
      tabTranscript.classList.add('active');
      tabSummary.classList.remove('active');
      panelTranscript.classList.remove('hidden');
      panelSummary.classList.add('hidden');
    } else {
      tabTranscript.classList.remove('active');
      tabSummary.classList.add('active');
      panelTranscript.classList.add('hidden');
      panelSummary.classList.remove('hidden');
    }
  }

  /**
   * Controls main screen rendering state configurations.
   */
  /**
   * Controls main screen rendering state configurations.
   */
  function updateStateView(state, errorMsg = null, summaryData = null) {
    activeState = state;

    const startBtn = document.getElementById('scribe-start-btn');
    const stopBtn = document.getElementById('scribe-stop-btn');
    const pauseBtn = document.getElementById('scribe-pause-btn');
    const cancelBtn = document.getElementById('scribe-cancel-btn');
    const statusText = document.getElementById('scribe-status-text');

    if (!startBtn || !stopBtn) return;

    const t = {
      vi: {
        recording: 'Ghi âm',
        paused: 'Tạm dừng',
        summarizing: 'Đang tóm tắt',
        done: 'Hoàn thành',
        error: 'Lỗi',
        idle: 'Chờ',
        pauseRec: '⏸️ Tạm dừng',
        resumeRec: '▶️ Tiếp tục',
        processFailure: '⚠️ Lỗi hệ thống',
        systemError: 'Đã xảy ra lỗi chụp màn hình/âm thanh.',
        noLogs: 'Chưa có bản ghi âm. Nhấn Bắt đầu để bắt đầu thu.',
        noReports: 'Chưa có báo cáo thông minh. Hoàn thành phiên ghi âm để tạo báo cáo.'
      },
      en: {
        recording: 'Recording',
        paused: 'Paused',
        summarizing: 'Summarizing',
        done: 'Done',
        error: 'Error',
        idle: 'Idle',
        pauseRec: '⏸️ Pause',
        resumeRec: '▶️ Resume',
        processFailure: '⚠️ Process Failure',
        systemError: 'A system capture error occurred.',
        noLogs: 'No audio transcribed yet. Click Start to begin capturing.',
        noReports: 'No intelligence reports compiled yet. Complete a recording session to generate reports.'
      }
    }[uiLanguage] || {
      recording: 'Recording', paused: 'Paused', summarizing: 'Summarizing', done: 'Done', error: 'Error', idle: 'Idle',
      pauseRec: '⏸️ Pause', resumeRec: '▶️ Resume', processFailure: '⚠️ Process Failure', systemError: 'A system capture error occurred.',
      noLogs: 'No audio transcribed yet. Click Start to begin capturing.', noReports: 'No intelligence reports compiled yet. Complete a recording session to generate reports.'
    };

    if (statusText) {
      statusText.className = 'scribe-status-badge ' + state.toLowerCase();
      statusText.textContent = t[state.toLowerCase()] || state;
    }

    switch (state) {
      case 'RECORDING':
        startBtn.disabled = true;
        stopBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = 'flex';
        if (pauseBtn) {
          pauseBtn.style.display = 'flex';
          pauseBtn.textContent = t.pauseRec;
        }
        
        // Clear previous empty placeholder on initial recording start
        const liveBox = document.getElementById('scribe-live-box');
        if (liveBox && liveBox.querySelector('.scribe-transcript-empty')) {
          liveBox.innerHTML = '';
        }
        break;

      case 'PAUSED':
        startBtn.disabled = true;
        stopBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = 'flex';
        if (pauseBtn) {
          pauseBtn.style.display = 'flex';
          pauseBtn.textContent = t.resumeRec;
        }
        break;

      case 'SUMMARIZING':
        startBtn.disabled = true;
        stopBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (pauseBtn) pauseBtn.style.display = 'none';
        showLoadingSpinner('Synthesizing Meeting Intelligence...', 'Gemini is compiling topic segments & rolling summaries.');
        switchTab('SUMMARY');
        break;

      case 'COMPLETED':
        startBtn.disabled = false;
        stopBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (pauseBtn) pauseBtn.style.display = 'none';
        
        if (summaryData) {
          renderFormattedSummary(summaryData);
        } else {
          // If state is COMPLETED but summary hasn't arrived yet, pull from storage
          if (!checkContextValidity()) return;
          chrome.storage.local.get(['finalSummary'], (data) => {
            renderFormattedSummary(data.finalSummary);
          });
        }
        switchTab('SUMMARY');
        break;

      case 'ERROR':
        startBtn.disabled = false;
        stopBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'flex';
        if (pauseBtn) pauseBtn.style.display = 'none';
        showErrorPanel(errorMsg || t.systemError);
        break;

      case 'IDLE':
      default:
        startBtn.disabled = false;
        stopBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (pauseBtn) pauseBtn.style.display = 'none';
        
        // Reset live logs box
        const liveBoxIdle = document.getElementById('scribe-live-box');
        if (liveBoxIdle) {
          liveBoxIdle.innerHTML = `<div class="scribe-transcript-empty">${t.noLogs}</div>`;
        }
        // Reset summary box
        const summaryViewIdle = document.getElementById('scribe-summary-view');
        if (summaryViewIdle) {
          summaryViewIdle.innerHTML = `<div class="scribe-transcript-empty">${t.noReports}</div>`;
        }
        break;
    }

    // Dynamic sizing and display of log export row
    updateExportLogsVisibility();
  }

  /**
   * Shows or hides the export transcript logs actions row based on state and contents.
   * Adjusts the height of the transcript container box to prevent clipping.
   */
  function updateExportLogsVisibility() {
    const exportRow = document.getElementById('scribe-export-logs-row');
    const liveBox = document.getElementById('scribe-live-box');
    if (!exportRow || !liveBox) return;

    // Show export buttons if:
    // 1. We are currently PAUSED, IDLE, or COMPLETED, AND
    // 2. There is actually transcribed content (at least one segment)
    const hasSegments = liveBox.querySelector('.scribe-transcript-segment') !== null;
    const isExportableState = ['PAUSED', 'IDLE', 'COMPLETED'].includes(activeState);

    if (isExportableState && hasSegments) {
      exportRow.style.display = 'flex';
      liveBox.style.height = '260px'; // Shrunk box to fit export controls perfectly!
    } else {
      exportRow.style.display = 'none';
      liveBox.style.height = '330px'; // Restore standard box height
    }
  }

  /**
   * Parsed segments inside live transcripts box and exports to .txt, .doc, .docx, or .pdf
   */
  function exportTranscriptData(format) {
    const liveBox = document.getElementById('scribe-live-box');
    if (!liveBox) return;

    const segments = Array.from(liveBox.querySelectorAll('.scribe-transcript-segment'));
    if (segments.length === 0) {
      alert('Không có nội dung bản ghi để xuất!');
      return;
    }

    const parsedSegments = segments.map(seg => {
      const timestampEl = seg.querySelector('.scribe-timestamp');
      const speakerEl = seg.querySelector('.scribe-speaker-badge');
      const textEl = seg.querySelector('.scribe-segment-text') || seg.querySelector('span:not(.scribe-timestamp):not(.scribe-speaker-badge)');
      
      return {
        timestamp: timestampEl ? timestampEl.textContent.trim() : '',
        speaker: speakerEl ? speakerEl.textContent.trim() : '',
        text: textEl ? textEl.textContent.trim() : seg.textContent.replace(timestampEl?.textContent || '', '').trim()
      };
    });

    const timestampFile = new Date().toISOString().slice(0,10) + '_' + new Date().toTimeString().slice(0,8).replace(/:/g, '-');
    const filename = `scribe_transcript_${timestampFile}.${format}`;

    if (format === 'txt') {
      let txtContent = '';
      parsedSegments.forEach(s => {
        const prefix = s.speaker ? `${s.timestamp} ${s.speaker}: ` : `${s.timestamp} `;
        txtContent += `${prefix}${s.text}\n`;
      });
      const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
      triggerDownload(blob, filename);
    } else if (format === 'doc' || format === 'docx') {
      let html = `
        <html xmlns:o='urn:schemas-microsoft-microsoft-org:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
        <head>
          <title>Gemini Scribe Meeting Transcript</title>
          <!--[if gte mso 9]>
          <xml>
            <w:WordDocument>
              <w:View>Print</w:View>
              <w:Zoom>100</w:Zoom>
              <w:DoNotOptimizeForBrowser/>
            </w:WordDocument>
          </xml>
          <![endif]-->
          <style>
            body {
              font-family: 'Segoe UI', Arial, sans-serif;
              line-height: 1.6;
              color: #1f2937;
              padding: 40px;
            }
            h1 {
              color: #7c3aed;
              font-size: 22px;
              border-bottom: 2px solid #e9d5ff;
              padding-bottom: 8px;
              margin-bottom: 20px;
            }
            .meta-table {
              width: 100%;
              border-collapse: collapse;
              margin-bottom: 24px;
              background-color: #f9fafb;
              border: 1px solid #f3f4f6;
            }
            .meta-table td {
              padding: 10px 15px;
              font-size: 13px;
              color: #4b5563;
            }
            .segment {
              margin-bottom: 12px;
              padding: 8px 12px;
              background-color: #faf5ff;
              border-left: 3px solid #8b5cf6;
            }
            .timestamp {
              font-size: 11px;
              color: #7c3aed;
              font-weight: bold;
              margin-right: 8px;
            }
            .speaker {
              font-weight: bold;
              color: #1e1b4b;
              background-color: #ddd6fe;
              padding: 2px 6px;
              font-size: 12px;
              margin-right: 8px;
            }
            .text {
              font-size: 13px;
              color: #1f2937;
            }
          </style>
        </head>
        <body>
          <h1>📝 Gemini Scribe - Meeting Transcript</h1>
          <table class="meta-table">
            <tr>
              <td><strong>Export Date:</strong> ${new Date().toLocaleString()}</td>
              <td><strong>Capture Source:</strong> ${captureMode === 'gmeet' ? 'Google Meet Subtitles' : 'Voice Capture (WebSocket STT)'}</td>
            </tr>
          </table>
      `;

      parsedSegments.forEach(s => {
        const speakerHtml = s.speaker ? `<span class="speaker">${escapeHtml(s.speaker)}</span>` : '';
        html += `
          <div class="segment">
            <span class="timestamp">${s.timestamp}</span>
            ${speakerHtml}
            <span class="text">${escapeHtml(s.text)}</span>
          </div>
        `;
      });

      html += `
        </body>
        </html>
      `;

      const mimeType = format === 'doc' ? 'application/msword' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const blob = new Blob([html], { type: `${mimeType};charset=utf-8` });
      triggerDownload(blob, filename);
    } else if (format === 'pdf') {
      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = 'none';
      document.body.appendChild(iframe);
      
      const iframeDoc = iframe.contentWindow.document;
      iframeDoc.open();
      iframeDoc.write(`
        <html>
        <head>
          <title>Gemini Scribe Meeting Transcript</title>
          <style>
            @page {
              size: A4;
              margin: 20mm;
            }
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              line-height: 1.6;
              color: #1f2937;
              padding: 20px;
            }
            h1 {
              color: #7c3aed;
              font-size: 22px;
              border-bottom: 2px solid #e9d5ff;
              padding-bottom: 8px;
              margin-bottom: 20px;
            }
            .meta {
              margin-bottom: 24px;
              font-size: 12px;
              color: #4b5563;
              border-bottom: 1px solid #e5e7eb;
              padding-bottom: 12px;
            }
            .segment {
              margin-bottom: 12px;
              page-break-inside: avoid;
              padding: 6px 12px;
              background-color: #faf5ff;
              border-left: 3px solid #8b5cf6;
              border-radius: 4px;
            }
            .timestamp {
              font-size: 11px;
              color: #7c3aed;
              font-weight: bold;
              margin-right: 8px;
            }
            .speaker {
              font-weight: bold;
              color: #1e1b4b;
              background-color: #ddd6fe;
              padding: 2px 6px;
              border-radius: 4px;
              font-size: 11px;
              margin-right: 8px;
            }
            .text {
              font-size: 13px;
            }
          </style>
        </head>
        <body>
          <h1>📝 Gemini Scribe - Meeting Transcript</h1>
          <div class="meta">
            <strong>Export Date:</strong> ${new Date().toLocaleString()} | 
            <strong>Capture Source:</strong> ${captureMode === 'gmeet' ? 'Google Meet Subtitles' : 'Voice Capture (WebSocket STT)'}
          </div>
      `);

      parsedSegments.forEach(s => {
        const speakerHtml = s.speaker ? `<span class="speaker">${escapeHtml(s.speaker)}</span>` : '';
        iframeDoc.write(`
          <div class="segment">
            <span class="timestamp">${s.timestamp}</span>
            ${speakerHtml}
            <span class="text">${escapeHtml(s.text)}</span>
          </div>
        `);
      });

      iframeDoc.write(`
        </body>
        </html>
      `);
      iframeDoc.close();

      // Trigger standard print dialog
      iframe.contentWindow.focus();
      setTimeout(() => {
        iframe.contentWindow.print();
        setTimeout(() => {
          document.body.removeChild(iframe);
        }, 2000);
      }, 500);
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Append a transcribed segment block to the live transcript display container.
   */
  function appendLiveTranscript(text) {
    const liveBox = document.getElementById('scribe-live-box');
    if (!liveBox) return;

    // Remove empty placeholder
    const emptyEl = liveBox.querySelector('.scribe-transcript-empty');
    if (emptyEl) {
      liveBox.innerHTML = '';
    }

    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const segment = document.createElement('div');
    segment.className = 'scribe-transcript-segment';
    segment.innerHTML = `
      <span class="scribe-timestamp">[${timeStr}]</span>
      <span>${escapeHtml(text)}</span>
    `;

    liveBox.appendChild(segment);
    
    // Auto-scroll to bottom of logs box
    liveBox.scrollTop = liveBox.scrollHeight;

    // Dynamic sizing and display of log export row
    updateExportLogsVisibility();
  }

  /**
   * Renders the loading feedback visualizer inside Summary panel.
   */
  function showLoadingSpinner(title, subtext) {
    const summaryView = document.getElementById('scribe-summary-view');
    if (!summaryView) return;

    summaryView.innerHTML = `
      <div class="scribe-loading-panel">
        <div class="scribe-spinner"></div>
        <div class="scribe-loading-text">${escapeHtml(title)}</div>
        <div class="scribe-loading-subtext">${escapeHtml(subtext)}</div>
      </div>
    `;
  }

  /**
   * Renders the error alerts inside Summary panel.
   */
  function showErrorPanel(message) {
    const summaryView = document.getElementById('scribe-summary-view');
    if (!summaryView) return;

    summaryView.innerHTML = `
      <div class="scribe-error-panel">
        <div class="scribe-error-title">⚠️ Process Failure</div>
        <div class="scribe-error-text">${escapeHtml(message)}</div>
      </div>
    `;
  }

  /**
   * Renders parsed structured JSON cards onto the summary board.
   */
  function renderFormattedSummary(data) {
    const summaryView = document.getElementById('scribe-summary-view');
    if (!summaryView || !data) return;

    const t = {
      vi: {
        noTopics: 'Chưa có chủ đề nào được tóm tắt.',
        noDecisions: 'Chưa có quyết định nào được ghi nhận.',
        noActions: 'Không có công việc nào được phân công.',
        unassigned: 'Chưa phân công',
        noDeadline: 'Không xác định',
        topicsTitle: '📌 Các Chủ đề Chính',
        decisionsTitle: '🎯 Các Quyết định',
        actionsTitle: '🚀 Công việc (Tasks)',
        difficultiesTitle: '⚠️ Khó khăn & Vấn đề Quy trình',
        noDifficulties: 'Không ghi nhận khó khăn hoặc sự cố nào phát sinh.',
        aiSuggestBtn: '🤖 Gợi ý AI',
        thinking: 'Đang xử lý...',
        citationTitle: 'Trích dẫn quy trình SOP:',
        exportExcel: '📥 Xuất Excel',
        exportTitle: 'Xuất danh sách sang Microsoft Excel',
        noExportData: 'Không có công việc nào để xuất!'
      },
      en: {
        noTopics: 'No structured topics extracted.',
        noDecisions: 'No decisions explicitly agreed upon.',
        noActions: 'No direct action items assigned.',
        unassigned: 'Unassigned',
        noDeadline: 'Not specified',
        topicsTitle: '📌 Key Topics Discussed',
        decisionsTitle: '🎯 Agreements & Decisions',
        actionsTitle: '🚀 Tasks & Action Items',
        difficultiesTitle: '⚠️ Process Bottlenecks & Difficulties',
        noDifficulties: 'No process difficulties or incidents were reported.',
        aiSuggestBtn: '🤖 AI Suggestion',
        thinking: 'Thinking...',
        citationTitle: 'SOP Citation:',
        exportExcel: '📥 Export Excel',
        exportTitle: 'Export list to Microsoft Excel',
        noExportData: 'No action items to export!'
      }
    }[uiLanguage] || t['vi'];

    // 1. Build Topics Section
    let topicsHtml = '';
    if (data.topics && data.topics.length > 0) {
      try {
        data.topics.forEach((topic) => {
          topicsHtml += `
            <div class="scribe-topic-card">
              <h4 class="scribe-topic-title">${escapeHtml(topic.title)}</h4>
              <p class="scribe-topic-text">${escapeHtml(topic.summary)}</p>
            </div>
          `;
        });
      } catch (err) {
        console.error('Topic render crash:', err);
      }
    } else {
      topicsHtml = `<div class="scribe-transcript-empty">${t.noTopics}</div>`;
    }

    // 2. Build Decisions Section
    let decisionsHtml = '';
    if (data.decisions && data.decisions.length > 0) {
      data.decisions.forEach((dec) => {
        decisionsHtml += `<div class="scribe-decision-item">${escapeHtml(dec)}</div>`;
      });
    } else {
      decisionsHtml = `<div class="scribe-transcript-empty">${t.noDecisions}</div>`;
    }

    // 3. Build Action Items Section
    let actionsHtml = '';
    if (data.actionItems && data.actionItems.length > 0) {
      data.actionItems.forEach((action) => {
        const assignee = action.assignee || t.unassigned;
        const deadline = action.deadline || t.noDeadline;
        actionsHtml += `
          <div class="scribe-action-item" style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div class="scribe-action-details" style="flex: 1; min-width: 0;">
              <div class="scribe-action-task" style="word-break: break-word;">${escapeHtml(action.task)}</div>
              <div class="scribe-action-meta" style="margin-top: 4px;">
                <span class="scribe-pill scribe-pill-assignee">${escapeHtml(assignee)}</span>
                <span class="scribe-pill scribe-pill-deadline">📅 ${escapeHtml(deadline)}</span>
              </div>
            </div>
            <!-- Status Dropdown Select -->
            <select class="scribe-action-status" data-task="${escapeHtml(action.task)}" data-assignee="${escapeHtml(assignee)}" data-deadline="${escapeHtml(deadline)}">
              <option value="To Do" selected>To Do</option>
              <option value="In Progress">In Progress</option>
              <option value="Done">Done</option>
            </select>
          </div>
        `;
      });
    } else {
      actionsHtml = `<div class="scribe-transcript-empty">${t.noActions}</div>`;
    }

    // 4. Build Difficulties Section (Micro-MRP)
    let difficultiesHtml = '';
    if (data.difficulties && data.difficulties.length > 0) {
      data.difficulties.forEach((diff) => {
        const raisedBy = diff.raisedBy || t.unassigned;
        difficultiesHtml += `
          <div class="scribe-difficulty-card" id="difficulty-card-${diff.id}" style="margin-bottom: 12px; padding: 12px; background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.15); border-radius: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;">
              <div style="flex: 1; min-width: 0;">
                <h4 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 600; color: #fca5a5; word-break: break-word;">${escapeHtml(diff.title)}</h4>
                <p style="margin: 0 0 8px 0; font-size: 12px; color: #e8eaed; line-height: 1.4; word-break: break-word;">${escapeHtml(diff.description)}</p>
                <div style="font-size: 11px; color: #9aa0a6;">
                  <span>Nguồn: </span><span class="scribe-pill" style="background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15); font-size: 10px; padding: 1px 6px; border-radius: 4px; color: #e8eaed; display: inline-block; vertical-align: middle;">${escapeHtml(raisedBy)}</span>
                </div>
              </div>
              <button class="scribe-btn-ai-suggest" data-diff-id="${diff.id}" data-diff-text="${escapeHtml(diff.description)}" style="background: linear-gradient(135deg, #a855f7 0%, #3b82f6 100%); border: none; border-radius: 6px; color: white; padding: 6px 12px; cursor: pointer; font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 4px; transition: transform 0.2s, box-shadow 0.2s; white-space: nowrap; flex-shrink: 0;">
                ${t.aiSuggestBtn}
              </button>
            </div>
            <!-- AI grounded suggestion result container -->
            <div class="scribe-ai-suggestion-container hidden" style="margin-top: 12px; padding: 10px; background: rgba(168, 85, 247, 0.08); border-left: 3px solid #a855f7; border-radius: 4px; font-size: 12px; line-height: 1.5; color: #e8eaed;">
              <div class="scribe-ai-suggestion-text" style="word-break: break-word;"></div>
              <div class="scribe-ai-suggestion-citation hidden" style="margin-top: 8px; font-size: 11px; font-style: italic; color: #a7f3d0; background: rgba(52, 211, 153, 0.1); padding: 6px; border-radius: 4px; border: 1px dashed rgba(52, 211, 153, 0.3); word-break: break-word;">
                <strong style="color: #34d399; font-style: normal; display: block; margin-bottom: 2px;">${t.citationTitle}</strong>
                <span class="scribe-ai-citation-content"></span>
              </div>
            </div>
          </div>
        `;
      });
    } else {
      difficultiesHtml = `<div class="scribe-transcript-empty">${t.noDifficulties}</div>`;
    }

    // Compile into dashboard bento layout
    summaryView.innerHTML = `
      <div class="scribe-summary-wrapper">
        <!-- Topics Section -->
        <section class="scribe-summary-section">
          <h3 class="scribe-section-title">${t.topicsTitle}</h3>
          ${topicsHtml}
        </section>

        <!-- Decisions Section -->
        <section class="scribe-summary-section">
          <h3 class="scribe-section-title">${t.decisionsTitle}</h3>
          ${decisionsHtml}
        </section>

        <!-- Difficulties Section -->
        <section class="scribe-summary-section">
          <h3 class="scribe-section-title">${t.difficultiesTitle}</h3>
          ${difficultiesHtml}
        </section>

        <!-- Action Items Section -->
        <section class="scribe-summary-section">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 8px;">
            <h3 class="scribe-section-title" style="margin-bottom: 0;">${t.actionsTitle}</h3>
            <button id="scribe-export-excel-btn" class="scribe-export-btn" title="${t.exportTitle}">
              ${t.exportExcel}
            </button>
          </div>
          ${actionsHtml}
        </section>
      </div>
    `;

    // Bind Export Excel event
    const exportBtn = document.getElementById('scribe-export-excel-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const statusSelects = document.querySelectorAll('.scribe-action-status');
        if (statusSelects.length === 0) {
          alert(t.noExportData);
          return;
        }

        const items = [];
        statusSelects.forEach(select => {
          items.push({
            assignee: select.getAttribute('data-assignee') || '',
            task: select.getAttribute('data-task') || '',
            deadline: select.getAttribute('data-deadline') || '',
            status: select.value
          });
        });

        // Generate CSV file content with BOM to support Vietnamese character displays in Excel
        const BOM = '\uFEFF';
        let csvContent = BOM + 'assignee,task,deadline,Status\r\n';
        items.forEach(item => {
          const row = [
            `"${item.assignee.replace(/"/g, '""')}"`,
            `"${item.task.replace(/"/g, '""')}"`,
            `"${item.deadline.replace(/"/g, '""')}"`,
            `"${item.status.replace(/"/g, '""')}"`
          ].join(',');
          csvContent += row + '\r\n';
        });

        // Trigger safe file download in browser
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().slice(0, 10);
        link.href = url;
        link.setAttribute('download', `ScribeAI_Action_Items_${timestamp}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      });
    }

    // Bind AI Suggestion click listeners for Difficulties
    const suggestButtons = summaryView.querySelectorAll('.scribe-btn-ai-suggest');
    suggestButtons.forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();

        const diffId = btn.getAttribute('data-diff-id');
        const diffText = btn.getAttribute('data-diff-text');

        // Find container and text elements inside this card
        const card = document.getElementById(`difficulty-card-${diffId}`);
        if (!card) return;

        const container = card.querySelector('.scribe-ai-suggestion-container');
        const suggestionTextEl = card.querySelector('.scribe-ai-suggestion-text');
        const citationEl = card.querySelector('.scribe-ai-suggestion-citation');
        const citationContentEl = card.querySelector('.scribe-ai-citation-content');

        if (!container || !suggestionTextEl) return;

        // Show container and loading state
        container.classList.remove('hidden');
        citationEl.classList.add('hidden');
        suggestionTextEl.innerHTML = `<span style="display: inline-flex; align-items: center; gap: 6px;"><span class="scribe-spinner" style="width: 14px; height: 14px; border-width: 1.5px; border-top-color: #a855f7;"></span>${t.thinking}</span>`;

        // Disable button to prevent concurrent duplicate calls
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.style.cursor = 'not-allowed';

        if (!checkContextValidity()) {
          suggestionTextEl.innerHTML = `<span style="color: #fca5a5;">⚠️ Context invalidated. Reload needed.</span>`;
          btn.disabled = false;
          btn.style.opacity = '1';
          btn.style.cursor = 'pointer';
          return;
        }

        chrome.runtime.sendMessage({
          action: 'GET_SOP_SUGGESTION',
          difficultyText: diffText
        }, (response) => {
          btn.disabled = false;
          btn.style.opacity = '1';
          btn.style.cursor = 'pointer';

          if (!response || !response.success) {
            suggestionTextEl.innerHTML = `<span style="color: #fca5a5;">⚠️ Lỗi: ${escapeHtml(response?.error || 'Unknown error')}</span>`;
            return;
          }

          const result = response.result;
          if (result.status === 'not_found' || result.solution.includes('Not found in provided SOP documents.')) {
            suggestionTextEl.innerHTML = `<span style="color: #9aa0a6; font-style: italic;">Not found in provided SOP documents.</span>`;
            citationEl.classList.add('hidden');
          } else {
            suggestionTextEl.textContent = result.solution;
            if (result.citation) {
              citationContentEl.textContent = result.citation;
              citationEl.classList.remove('hidden');
            } else {
              citationEl.classList.add('hidden');
            }
          }
        });
      });
    });
  }
  /**
   * ═══════════════════════════════════════════════════════════════════
   * GOOGLE MEET CAPTION SCRAPING MODE
   * Uses MutationObserver to read captions directly from Google Meet's
   * built-in subtitle DOM elements (div.ygicle.VbkSUe for text,
   * span.NWpY1d for speaker names).
   * ═══════════════════════════════════════════════════════════════════
   */

  /**
   * Agnostic Closed Caption (CC) Auto-Enabler
   * Scans buttons in the Google Meet toolbar to locate and click the caption toggle.
   * Utilizes language-independent SVG paths (Material Design CC icon coordinates)
   * and generic attribute string patterns.
   */
  function ensureGoogleMeetCCEnabled() {
    // 1. If the caption container already exists, captions are active.
    const captionContainer = document.querySelector('div[role="region"][aria-label="Phụ đề"]')
                          || document.querySelector('div[role="region"][aria-label="Captions"]')
                          || document.querySelector('div.vNKgIf')
                          || document.querySelector('div[aria-live="polite"]');
    if (captionContainer) {
      console.log('[Scribe CC] Captions are already active.');
      return;
    }

    console.log('[Scribe CC] Attempting to auto-enable closed captions...');

    // 2. Scan toolbar buttons
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();

      // Heuristic A: Aria-label or Tooltip matching common CC indicators across EN/VI
      if (
        ariaLabel.includes('caption') || ariaLabel.includes('phụ đề') || ariaLabel.includes(' phụ đề') ||
        tooltip.includes('caption') || tooltip.includes('phụ đề') ||
        ariaLabel === 'cc' || tooltip === 'cc'
      ) {
        console.log('[Scribe CC] Found CC toggle via label/tooltip:', btn);
        btn.click();
        return;
      }

      // Heuristic B: SVG path fingerprinting (Material Design Closed Caption button)
      const paths = btn.querySelectorAll('path');
      for (const path of paths) {
        const d = path.getAttribute('d') || '';
        
        // CC bounding box or characters path coordinates standard coordinates
        if (
          d.includes('M19 4H5') || 
          d.includes('M20 4H4') || 
          d.includes('19H5V5h14v14z') || 
          d.includes('M19,4H5C3.89,4') ||
          d.includes('M19 4c1.1 0 2')
        ) {
          console.log('[Scribe CC] Found CC toggle via SVG icon fingerprint:', btn);
          btn.click();
          return;
        }
      }
    }
  }

  /**
   * Start observing Google Meet's caption container for real-time text changes.
   */
  function startGmeetCaptionObserver() {
    // Clean up any previous observer
    stopGmeetCaptionObserver();
    lastCaptionTexts.clear();

    // Auto-enable captions seamlessly before observing
    ensureGoogleMeetCCEnabled();

    console.log('[Scribe GMeet] Starting Google Meet caption observer...');

    // Short timeout to allow Google Meet UI to mount the caption DOM elements if clicked
    setTimeout(() => {
      // Find the caption region container
      const captionContainer = document.querySelector('div[role="region"][aria-label="Phụ đề"]')
                            || document.querySelector('div[role="region"][aria-label="Captions"]')
                            || document.querySelector('div.vNKgIf')
                            || document.querySelector('div[aria-live="polite"]');

      if (!captionContainer) {
        console.warn('[Scribe GMeet] Caption container not found. Make sure Google Meet captions (CC) are turned ON.');
        appendLiveTranscript('⚠️ Không tìm thấy vùng phụ đề Google Meet. Hãy bật phụ đề (CC) trong Google Meet trước khi sử dụng chế độ này.');
        return;
      }

      console.log('[Scribe GMeet] Caption container found. Attaching MutationObserver...');
      appendLiveTranscript('✅ Đã kết nối với phụ đề Google Meet. Đang lắng nghe...');

      // Perform initial scan of existing captions already visible
      scanExistingCaptions(captionContainer);

      // Create MutationObserver to watch for all DOM changes inside the caption container
      gmeetObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          // Case 1: New speaker blocks added (childList on container)
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                processCaptionBlock(node);
              }
            });
          }

          // Case 2: Text content changed within existing caption elements (characterData)
          if (mutation.type === 'characterData') {
            const parentEl = mutation.target.parentElement;
            if (parentEl) {
              const speakerBlock = parentEl.closest('.nMcdL') || parentEl.closest('[data-speaker-id]');
              if (speakerBlock) {
                processCaptionBlock(speakerBlock);
              }
            }
          }
        }
      });

      gmeetObserver.observe(captionContainer, {
        childList: true,
        subtree: true,
        characterData: true
      });

      console.log('[Scribe GMeet] MutationObserver active and listening for captions.');
    }, 400);
  }

  /**
   * Stop the Google Meet caption observer and clean up.
   */
  function stopGmeetCaptionObserver() {
    if (gmeetObserver) {
      gmeetObserver.disconnect();
      gmeetObserver = null;
      console.log('[Scribe GMeet] MutationObserver disconnected.');
    }
    lastCaptionTexts.clear();
  }

  /**
   * Scan existing visible caption blocks on initial observer start.
   */
  function scanExistingCaptions(container) {
    if (activeState === 'PAUSED') return;
    const blocks = container.querySelectorAll('.nMcdL') || container.children;
    Array.from(blocks).forEach((block) => {
      if (block.nodeType !== Node.ELEMENT_NODE) return;

      let textEl = block.querySelector('.ygicle.VbkSUe');
      let nameEl = block.querySelector('span.NWpY1d');

      // Heuristic fallback for rotated/dynamic class names
      if (!textEl) {
        const spans = Array.from(block.querySelectorAll('span, div')).filter(el => el.textContent.trim().length > 0);
        if (spans.length > 0) {
          nameEl = nameEl || spans[0];
          textEl = spans[spans.length - 1];
        }
      }

      if (textEl) {
        const text = textEl.textContent.trim();
        const speaker = nameEl ? nameEl.textContent.trim() : 'Unknown';
        if (text) {
          // Generate a unique key for this block
          const blockKey = generateBlockKey(block);
          lastCaptionTexts.set(blockKey, text);
          appendGmeetCaption(speaker, text, blockKey);
          saveCaptionToStorage(blockKey, speaker, text);
        }
      }
    });
  }

  /**
   * Process a single caption block element, extracting speaker + text.
   * Only emits when text has actually changed from last known value.
   */
  function processCaptionBlock(element) {
    if (activeState === 'PAUSED') return;
    // The element might be the block itself or a child element
    const block = element.classList?.contains('nMcdL') ? element : element.closest('.nMcdL');
    if (!block) return;

    let textEl = block.querySelector('.ygicle.VbkSUe');
    let nameEl = block.querySelector('span.NWpY1d');

    // Heuristic fallback for rotated/dynamic class names
    if (!textEl) {
      const spans = Array.from(block.querySelectorAll('span, div')).filter(el => el.textContent.trim().length > 0);
      if (spans.length > 0) {
        nameEl = nameEl || spans[0];
        textEl = spans[spans.length - 1];
      }
    }

    if (!textEl) return;

    const currentText = textEl.textContent.trim();
    const speaker = nameEl ? nameEl.textContent.trim() : 'Unknown';
    if (!currentText) return;

    const blockKey = generateBlockKey(block);
    const previousText = lastCaptionTexts.get(blockKey);

    // Only process if text is genuinely new or changed
    if (currentText !== previousText) {
      lastCaptionTexts.set(blockKey, currentText);
      appendGmeetCaption(speaker, currentText, blockKey);
      saveCaptionToStorage(blockKey, speaker, currentText);
    }
  }

  /**
   * Generate a stable unique key for a caption block element.
   */
  function generateBlockKey(block) {
    let nameEl = block.querySelector('span.NWpY1d');
    let imgEl = block.querySelector('img.Z6byG') || block.querySelector('img');

    // Heuristic fallback for rotated/dynamic class names
    if (!nameEl) {
      const spans = Array.from(block.querySelectorAll('span, div')).filter(el => el.textContent.trim().length > 0);
      nameEl = spans[0];
    }

    const speaker = nameEl ? nameEl.textContent.trim() : 'unknown';
    const imgSrc = imgEl ? imgEl.src.slice(-20) : '';
    // Use index among siblings as additional uniqueness
    const parent = block.parentElement;
    const idx = parent ? Array.from(parent.children).indexOf(block) : 0;
    return `${speaker}_${imgSrc}_${idx}`;
  }

  /**
   * Append or update a Google Meet caption entry in the Live Logs panel with speaker badge.
   * Matches caption blocks by blockKey to allow real-time text updates in-place.
   */
  function appendGmeetCaption(speaker, text, blockKey) {
    const trimmedText = text.trim();
    if (!trimmedText) return;

    const liveBox = document.getElementById('scribe-live-box');
    if (!liveBox) return;

    // Remove empty placeholder
    const emptyEl = liveBox.querySelector('.scribe-transcript-empty');
    if (emptyEl) {
      liveBox.innerHTML = '';
    }

    // Try to find an existing segment row for this blockKey
    let segment = liveBox.querySelector(`[data-block-key="${blockKey}"]`);

    if (segment) {
      // Update text in-place!
      const textSpan = segment.querySelector('.scribe-segment-text');
      if (textSpan) {
        textSpan.textContent = trimmedText;
      }
    } else {
      // Create a brand new segment row
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      segment = document.createElement('div');
      segment.className = 'scribe-transcript-segment';
      segment.setAttribute('data-block-key', blockKey);
      segment.innerHTML = `
        <span class="scribe-timestamp">[${timeStr}]</span>
        <span class="scribe-speaker-badge">${escapeHtml(speaker)}</span>
        <span class="scribe-segment-text">${escapeHtml(trimmedText)}</span>
      `;
      liveBox.appendChild(segment);
    }

    liveBox.scrollTop = liveBox.scrollHeight;

    // Dynamic sizing and display of log export row
    updateExportLogsVisibility();
  }

  /**
   * Persist scraped caption text into IndexedDB via background worker for summarization.
   */
  function saveCaptionToStorage(blockKey, speaker, text) {
    if (!checkContextValidity()) return;
    chrome.runtime.sendMessage({
      action: 'UPDATE_GMEET_CAPTION',
      blockKey: blockKey,
      speaker: speaker,
      text: text
    });
  }

  // Update real-time mixed soundwave visualization meter
  function updateVolumeVisuals(volume) {
    const bars = document.querySelectorAll('.scribe-bar');
    if (!bars || bars.length === 0) return;
    
    // Distribute volume into different bar scale levels to create a wavy effect
    bars.forEach((bar, idx) => {
      const multipliers = [0.4, 0.7, 1.0, 1.2, 1.0, 0.7, 0.4];
      const mult = multipliers[idx] || 0.5;
      
      // Calculate height based on volume and multiplier, minimum 3px, max 20px
      const height = Math.max(3, Math.min(20, (volume * mult * 0.2)));
      bar.style.height = `${height}px`;
      
      if (volume > 5) {
        bar.style.background = 'linear-gradient(180deg, #ec4899 0%, #3b82f6 100%)';
        bar.style.boxShadow = '0 0 8px rgba(236, 72, 153, 0.6)';
      } else {
        bar.style.background = 'linear-gradient(180deg, #3b82f6 0%, #10b981 100%)';
        bar.style.boxShadow = '0 0 4px rgba(59, 130, 246, 0.2)';
      }
    });
  }

  // Escape HTML helper
  function escapeHtml(text) {
    if (!text) return '';
    return text
      .toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message) => {
    console.log('Content script received message:', message);

    if (message.action === 'STATE_CHANGED') {
      updateStateView(message.state, message.error);
    }

    if (message.action === 'LIVE_TRANSCRIPT_UPDATE') {
      appendLiveTranscript(message.text);
    }

    if (message.action === 'VOLUME_UPDATE') {
      updateVolumeVisuals(message.volume);
    }

    if (message.action === 'SUMMARIZATION_COMPLETE') {
      updateStateView('COMPLETED', null, message.summary);
    }

    if (message.action === 'SUMMARIZATION_ERROR') {
      updateStateView('ERROR', message.error);
    }
  });

  // Listen for storage changes to update UI language dynamically
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.uiLanguage) {
      uiLanguage = changes.uiLanguage.newValue || 'vi';
      // Re-render layout to apply language switch
      renderPanelLayout();
      // Restore active states after re-rendering
      chrome.storage.local.get(['recordingState', 'recordingError', 'finalSummary'], (data) => {
        updateStateView(data.recordingState || 'IDLE', data.recordingError, data.finalSummary);
      });
    }
  });

  // =========================================================================
  // Magic Pencil (Screen Crop & Translate) Integration
  // =========================================================================

  function startMagicPencilFlow() {
    if (!checkContextValidity()) return;

    // 1. Smoothly fade out scribe panel overlay so it doesn't get screenshotted
    overlayEl.style.opacity = '0';
    overlayEl.style.pointerEvents = 'none';

    // 2. Allow DOM to render hidden state, then capture the tab
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB' }, (response) => {
        // Restore overlay immediately
        overlayEl.style.opacity = '1';
        overlayEl.style.pointerEvents = 'auto';

        if (!response || !response.success) {
          alert('Lỗi chụp ảnh màn hình: ' + (response?.error || 'Unknown error'));
          return;
        }

        initializeScreenCropper(response.dataUrl);
      });
    }, 150);
  }

  function initializeScreenCropper(dataUrl) {
    // Prevent duplicate croppers
    if (document.querySelector('.scribe-crop-overlay')) return;

    const cropOverlay = document.createElement('div');
    cropOverlay.className = 'scribe-crop-overlay';

    const canvas = document.createElement('canvas');
    canvas.className = 'scribe-crop-canvas';
    cropOverlay.appendChild(canvas);
    document.body.appendChild(cropOverlay);

    const img = new Image();
    img.src = dataUrl;
    img.onload = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      
      // Draw initial screen state
      ctx.drawImage(img, 0, 0, width, height);

      let isDrawing = false;
      let startX = 0;
      let startY = 0;
      let endX = 0;
      let endY = 0;

      const drawCropArea = () => {
        // Redraw screenshot
        ctx.drawImage(img, 0, 0, width, height);
        
        // Semi-transparent mask overlay
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, 0, width, height);
        
        const rectX = Math.min(startX, endX);
        const rectY = Math.min(startY, endY);
        const rectW = Math.abs(startX - endX);
        const rectH = Math.abs(startY - endY);

        ctx.clearRect(rectX, rectY, rectW, rectH);
        
        // Restore clear image at active region
        ctx.drawImage(img, rectX, rectY, rectW, rectH, rectX, rectY, rectW, rectH);

        // Glowing border design
        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = 2;
        ctx.strokeRect(rectX, rectY, rectW, rectH);
      };

      const handleMouseDown = (e) => {
        if (e.button !== 0) return; // Only left click
        isDrawing = true;
        startX = e.clientX;
        startY = e.clientY;
        endX = e.clientX;
        endY = e.clientY;
        removeCropToolbar();
      };

      const handleMouseMove = (e) => {
        if (!isDrawing) return;
        endX = e.clientX;
        endY = e.clientY;
        drawCropArea();
      };

      const handleMouseUp = (e) => {
        if (!isDrawing) return;
        isDrawing = false;
        endX = e.clientX;
        endY = e.clientY;

        const rectW = Math.abs(startX - endX);
        const rectH = Math.abs(startY - endY);

        if (rectW < 5 || rectH < 5) {
          showCropToast('Vùng chọn quá nhỏ. Hãy vẽ lại!');
          ctx.drawImage(img, 0, 0, width, height);
          return;
        }

        const rectX = Math.min(startX, endX);
        const rectY = Math.min(startY, endY);
        showCropToolbar(rectX, rectY, rectW, rectH, img);
      };

      cropOverlay.addEventListener('mousedown', handleMouseDown);
      cropOverlay.addEventListener('mousemove', handleMouseMove);
      cropOverlay.addEventListener('mouseup', handleMouseUp);

      const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
          cleanupCropper();
        }
      };
      window.addEventListener('keydown', handleKeyDown);

      const cleanupCropper = () => {
        window.removeEventListener('keydown', handleKeyDown);
        removeCropToolbar();
        cropOverlay.remove();
      };

      currentCropCleanup = cleanupCropper;
    };
  }

  function removeCropToolbar() {
    if (activeCropToolbar) {
      activeCropToolbar.remove();
      activeCropToolbar = null;
    }
  }

  function showCropToolbar(x, y, w, h, img) {
    removeCropToolbar();

    const toolbar = document.createElement('div');
    toolbar.className = 'scribe-crop-toolbar';
    
    // Position adjustments to float right above selection
    let topPos = y - 46;
    if (topPos < 10) topPos = y + h + 10; // place below if no top room
    let leftPos = x + w - 240;
    if (leftPos < 10) leftPos = x;
    
    toolbar.style.top = `${topPos}px`;
    toolbar.style.left = `${leftPos}px`;

    toolbar.innerHTML = `
      <button class="scribe-crop-btn" id="scribe-crop-copy" title="Copy text extracted from screen">📋 Trích xuất</button>
      <select class="scribe-crop-select" id="scribe-crop-lang" title="Select translation target language">
        <option value="vi">Tiếng Việt</option>
        <option value="en">English</option>
        <option value="fr">Français</option>
      </select>
      <button class="scribe-crop-btn" id="scribe-crop-trans" title="Translate extracted text">🪄 Dịch</button>
      <button class="scribe-crop-btn danger" id="scribe-crop-close" title="Cancel snip (ESC)">❌</button>
    `;

    document.body.appendChild(toolbar);

    const closeBtn = toolbar.querySelector('#scribe-crop-close');
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      if (currentCropCleanup) currentCropCleanup();
    };

    const copyBtn = toolbar.querySelector('#scribe-crop-copy');
    copyBtn.onclick = async (e) => {
      e.stopPropagation();
      await executeVisionAction('extract', x, y, w, h, img, 'vi');
    };

    const transBtn = toolbar.querySelector('#scribe-crop-trans');
    transBtn.onclick = async (e) => {
      e.stopPropagation();
      const lang = toolbar.querySelector('#scribe-crop-lang').value;
      await executeVisionAction('translate', x, y, w, h, img, lang);
    };

    activeCropToolbar = toolbar;
  }

  async function executeVisionAction(mode, x, y, w, h, img, targetLang) {
    try {
      const toolbar = activeCropToolbar;
      if (toolbar) {
        toolbar.innerHTML = `
          <div class="scribe-spinner" style="width: 20px; height: 20px; border-width: 2px; border-top-color: #a855f7;"></div>
          <span style="font-size:12px; font-weight:500; color: #ffffff;">Đang phân tích bằng Gemini...</span>
        `;
      }

      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = w;
      cropCanvas.height = h;
      const cropCtx = cropCanvas.getContext('2d');
      cropCtx.drawImage(img, x, y, w, h, 0, 0, w, h);
      
      const dataUrl = cropCanvas.toDataURL('image/jpeg', 0.85);
      const base64Data = dataUrl.split(',')[1];

      let prompt = '';
      if (mode === 'extract') {
        prompt = 'Analyze the provided image. Perform highly accurate Optical Character Recognition (OCR) and extract all readable text. Retain the original layout, structure, and line breaks where possible. Output ONLY the extracted text. Do not write any introduction, pleasantries, or explanations.';
      } else {
        const langMap = {
          vi: 'Vietnamese',
          en: 'English',
          fr: 'French'
        };
        const langName = langMap[targetLang] || 'Vietnamese';
        prompt = `Analyze the provided image. First, perform highly accurate OCR to extract the text. Then, translate the extracted text into ${langName}. Output ONLY the translated text. Retain natural line breaks and formatting. Do not include any explanations, introductions, or annotations.`;
      }

      chrome.runtime.sendMessage({
        action: 'GEMINI_VISION_REQUEST',
        base64Image: base64Data,
        prompt: prompt
      }, (response) => {
        if (currentCropCleanup) currentCropCleanup();

        if (!response || !response.success) {
          alert('Lỗi phân tích hình ảnh: ' + (response?.error || 'Unknown error'));
          return;
        }

        showVisionResultModal(response.text, mode === 'extract' ? 'Kết quả trích xuất chữ' : 'Kết quả dịch thuật');
      });

    } catch (err) {
      console.error('Vision action failed:', err);
      alert('Không thể thực hiện tác vụ: ' + err.message);
      if (currentCropCleanup) currentCropCleanup();
    }
  }

  function showVisionResultModal(text, titleText) {
    const existing = document.querySelector('.scribe-result-modal-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'scribe-result-modal-backdrop';

    const card = document.createElement('div');
    card.className = 'scribe-result-card';

    card.innerHTML = `
      <div class="scribe-result-header">
        <div class="scribe-result-title">✨ ${titleText}</div>
        <button class="scribe-btn-header" id="scribe-result-close-x" title="Close">❌</button>
      </div>
      <div class="scribe-result-body">${escapeHtml(text)}</div>
      <div class="scribe-result-footer">
        <button class="scribe-crop-btn" id="scribe-result-copy" style="background: linear-gradient(135deg, hsl(262, 83%, 62%) 0%, hsl(282, 85%, 55%) 100%);">📋 Sao chép</button>
        <button class="scribe-crop-btn danger" id="scribe-result-close">Đóng</button>
      </div>
    `;

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    function escapeHtml(str) {
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    const closeX = card.querySelector('#scribe-result-close-x');
    const closeBtn = card.querySelector('#scribe-result-close');
    const copyBtn = card.querySelector('#scribe-result-copy');

    const closeModal = () => {
      backdrop.remove();
    };

    closeX.onclick = closeModal;
    closeBtn.onclick = closeModal;
    backdrop.onclick = (e) => {
      if (e.target === backdrop) closeModal();
    };

    copyBtn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.innerHTML = '✅ Đã sao chép!';
        setTimeout(() => {
          copyBtn.innerHTML = '📋 Sao chép';
        }, 2000);
      }).catch(err => {
        console.error('Failed to copy text:', err);
      });
    };
  }

  function showCropToast(msg) {
    const existing = document.querySelector('.scribe-crop-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'scribe-crop-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 40px;
      left: 50%;
      transform: translateX(-50%);
      padding: 10px 20px;
      background: rgba(220, 38, 38, 0.95);
      border: 1px solid rgba(220, 38, 38, 0.4);
      color: #ffffff;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      z-index: 1000002;
      box-shadow: 0 10px 25px rgba(0,0,0,0.4);
      font-family: sans-serif;
      animation: scribe-fade-in 0.2s ease;
    `;
    toast.innerText = msg;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 2500);
  }

})();
