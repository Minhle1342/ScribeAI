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
  let captureMode = 'websocket'; // 'websocket' | 'gmeet' | 'teams'
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
        teamsMode: '🟦 Bằng Phụ Đề (MS Teams)',
        startRec: '🔴 Bắt đầu Ghi',
        pauseRec: '⏸️ Tạm dừng',
        resumeRec: '▶️ Tiếp tục',
        stopRec: '⏹️ Dừng & Tóm tắt',
        cancelRec: '❌ Hủy bỏ',
        liveLogs: 'Nhật ký Trực tiếp',
        aiSummary: 'Tóm tắt AI',
        noLogs: 'Chưa có bản ghi âm. Nhấn Bắt đầu để bắt đầu thu.',
        noReports: 'Chưa có báo cáo thông minh. Hoàn thành phiên ghi âm để tạo báo cáo.'
      },
      en: {
        captureMode: '📡 Capture Mode',
        wsMode: '🎙️ Voice (WebSocket STT)',
        gmeetMode: '📋 Captions (Google Meet)',
        teamsMode: '🟦 Captions (MS Teams)',
        startRec: '🔴 Start Recording',
        pauseRec: '⏸️ Pause',
        resumeRec: '▶️ Resume',
        stopRec: '⏹️ Stop & Summary',
        cancelRec: '❌ Cancel',
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
                <option value="teams">${t.teamsMode}</option>
              </select>
            </div>
          </div>

          <!-- Control buttons row -->
          <div style="padding: 8px 20px 8px 20px;">
            <div class="scribe-actions-row">
              <button id="scribe-start-btn" class="scribe-btn scribe-btn-start">${t.startRec}</button>
              <button id="scribe-pause-btn" class="scribe-btn scribe-btn-pause" style="display: none;">${t.pauseRec}</button>
              <button id="scribe-stop-btn" class="scribe-btn scribe-btn-stop" disabled>${t.stopRec}</button>
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
            <!-- Quick Export Menu (Visible only when PAUSED) -->
            <div class="scribe-export-container" id="scribe-export-container" style="display: none;">
              <button type="button" class="scribe-export-trigger" id="scribe-export-btn">
                <span>📥 Export</span>
                <span style="font-size: 8px;">▼</span>
              </button>
              <div class="scribe-export-menu" id="scribe-export-dropdown">
                <button type="button" class="scribe-export-item" data-format="txt">📄 Plain Text (.txt)</button>
                <button type="button" class="scribe-export-item" data-format="doc">Word Document (.doc)</button>
                <button type="button" class="scribe-export-item" data-format="pdf">Print PDF (.pdf)</button>
              </div>
            </div>
            <div class="scribe-transcript-box" id="scribe-live-box" style="height: 330px;">
              <div class="scribe-transcript-empty">${t.noLogs}</div>
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

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function handleExport(format) {
    const liveBox = document.getElementById('scribe-live-box');
    if (!liveBox) return;

    const segments = Array.from(liveBox.querySelectorAll('.scribe-transcript-segment'));
    if (segments.length === 0) {
      alert('Không có dữ liệu nhật ký để xuất.');
      return;
    }

    let textLines = [];
    segments.forEach(segment => {
      const timestampEl = segment.querySelector('.scribe-timestamp');
      const speakerEl = segment.querySelector('.scribe-speaker-badge');
      const textSpan = segment.querySelector('.scribe-segment-text') || segment.querySelector('span:not(.scribe-timestamp)');
      
      const timestamp = timestampEl ? timestampEl.textContent.trim() : '';
      const speaker = speakerEl ? speakerEl.textContent.trim() : '';
      const text = textSpan ? textSpan.textContent.trim() : segment.textContent.replace(timestamp, '').trim();
      
      if (speaker) {
        textLines.push(`${timestamp} ${speaker}: ${text}`);
      } else {
        textLines.push(`${timestamp} ${text}`);
      }
    });

    const fileContent = textLines.join('\n');
    const meetingTitle = document.title || 'Meeting_Transcript';
    const cleanTitle = meetingTitle.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filename = `Scribe_${cleanTitle}_${new Date().toISOString().slice(0, 10)}`;

    if (format === 'txt') {
      const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8' });
      downloadBlob(blob, `${filename}.txt`);
    } else if (format === 'doc' || format === 'docx') {
      const wordHtml = `
        <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
        <head>
          <meta charset="utf-8">
          <title>${escapeHtml(meetingTitle)}</title>
          <style>
            body { font-family: 'Outfit', 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #1a1625; }
            h2 { color: #6f42c1; border-bottom: 2px solid #e2dff2; padding-bottom: 8px; }
            .timestamp { color: #7b75a4; font-size: 11px; margin-right: 8px; font-weight: bold; }
            .speaker { color: #6f42c1; font-weight: bold; margin-right: 8px; }
            .segment { margin-bottom: 12px; }
          </style>
        </head>
        <body>
          <h2>Meeting Transcript - ${escapeHtml(meetingTitle)}</h2>
          <p style="color: #7b75a4; font-size: 12px;">Exported on: ${new Date().toLocaleString()}</p>
          <hr/>
          ${segments.map(segment => {
            const timestampEl = segment.querySelector('.scribe-timestamp');
            const speakerEl = segment.querySelector('.scribe-speaker-badge');
            const textSpan = segment.querySelector('.scribe-segment-text') || segment.querySelector('span:not(.scribe-timestamp)');
            
            const timestamp = timestampEl ? timestampEl.textContent : '';
            const speaker = speakerEl ? speakerEl.textContent : '';
            const text = textSpan ? textSpan.textContent : segment.textContent;
            
            return `
              <div class="segment">
                <span class="timestamp">${escapeHtml(timestamp)}</span>
                ${speaker ? `<span class="speaker">${escapeHtml(speaker)}</span>` : ''}
                <span class="text">${escapeHtml(text)}</span>
              </div>
            `;
          }).join('')}
        </body>
        </html>
      `;
      const blob = new Blob(['\ufeff' + wordHtml], { type: 'application/msword;charset=utf-8' });
      downloadBlob(blob, `${filename}.doc`);
    } else if (format === 'pdf') {
      let iframe = document.getElementById('scribe-print-iframe');
      if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'scribe-print-iframe';
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        document.body.appendChild(iframe);
      }

      const iframeDoc = iframe.contentWindow.document;
      iframeDoc.open();
      iframeDoc.write(`
        <html>
        <head>
          <title>${escapeHtml(meetingTitle)}</title>
          <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
          <style>
            body {
              font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              color: #1e1e24;
              padding: 40px;
              line-height: 1.6;
            }
            .header {
              border-bottom: 2px solid #6f42c1;
              padding-bottom: 12px;
              margin-bottom: 24px;
            }
            .title {
              font-size: 24px;
              color: #6f42c1;
              margin: 0 0 6px 0;
              font-weight: 700;
            }
            .meta {
              font-size: 12px;
              color: #6c757d;
              margin: 0;
            }
            .segment {
              margin-bottom: 14px;
              font-size: 14px;
              page-break-inside: avoid;
            }
            .timestamp {
              color: #868e96;
              font-weight: 600;
              font-size: 12px;
              margin-right: 8px;
            }
            .speaker {
              color: #5e35b1;
              font-weight: 700;
              margin-right: 8px;
              background: #f3e5f5;
              padding: 2px 6px;
              border-radius: 4px;
              font-size: 12px;
            }
            .text {
              color: #212529;
            }
            @media print {
              body { padding: 0; }
              @page { size: A4; margin: 20mm; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h1 class="title">${escapeHtml(meetingTitle)}</h1>
            <p class="meta">Exported via Gemini Scribe on ${new Date().toLocaleString()}</p>
          </div>
          <div class="content">
            ${segments.map(segment => {
              const timestampEl = segment.querySelector('.scribe-timestamp');
              const speakerEl = segment.querySelector('.scribe-speaker-badge');
              const textSpan = segment.querySelector('.scribe-segment-text') || segment.querySelector('span:not(.scribe-timestamp)');
              
              const timestamp = timestampEl ? timestampEl.textContent : '';
              const speaker = speakerEl ? speakerEl.textContent : '';
              const text = textSpan ? textSpan.textContent : segment.textContent;
              
              return `
                <div class="segment">
                  <span class="timestamp">${escapeHtml(timestamp)}</span>
                  ${speaker ? `<span class="speaker">${escapeHtml(speaker)}</span>` : ''}
                  <span class="text">${escapeHtml(text)}</span>
                </div>
              `;
            }).join('')}
          </div>
          <script>
            window.onload = function() {
              window.focus();
              window.print();
            };
          </script>
        </body>
        </html>
      `);
      iframeDoc.close();
    }
  }

  /**
   * Hook click and switch event handlers to visual components.
   */
  function setupControllers() {
    const minimizeBtn = document.getElementById('scribe-minimize-btn');
    const magicBtn = document.getElementById('scribe-magic-btn');
    const startBtn = document.getElementById('scribe-start-btn');
    const pauseBtn = document.getElementById('scribe-pause-btn');
    const stopBtn = document.getElementById('scribe-stop-btn');
    const tabTranscript = document.getElementById('scribe-tab-transcript');
    const tabSummary = document.getElementById('scribe-tab-summary');
    const modeSelect = document.getElementById('scribe-capture-mode');

    // Export dropdown toggle
    const exportBtn = document.getElementById('scribe-export-btn');
    const exportDropdown = document.getElementById('scribe-export-dropdown');
    
    if (exportBtn && exportDropdown) {
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportDropdown.classList.toggle('show');
      });
      
      document.addEventListener('click', () => {
        exportDropdown.classList.remove('show');
      });
    }

    const exportItems = document.querySelectorAll('.scribe-export-item');
    exportItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const format = item.getAttribute('data-format');
        if (exportDropdown) exportDropdown.classList.remove('show');
        handleExport(format);
      });
    });

    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        if (!checkContextValidity()) return;
        chrome.runtime.sendMessage({ action: 'TOGGLE_PAUSE_REQUEST' }, (response) => {
          if (!response || !response.success) {
            console.error('[Scribe] Failed to toggle pause state:', response?.error);
          }
        });
      });
    }

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
      if (activeState === 'PAUSED') {
        if (!checkContextValidity()) return;
        chrome.runtime.sendMessage({ action: 'TOGGLE_PAUSE_REQUEST' }, (response) => {
          if (!response || !response.success) {
            console.error('[Scribe] Failed to toggle pause state:', response?.error);
          }
        });
        return;
      }

      if (captureMode === 'gmeet' || captureMode === 'teams') {
        // Caption scraping mode
        startBtn.disabled = true;
        stopBtn.disabled = false;
        if (checkContextValidity()) {
          chrome.storage.local.set({ gmeetCaptions: {} }, () => {
            chrome.runtime.sendMessage({ action: 'START_GMEET_RECORDING' }, () => {
              if (captureMode === 'teams') {
                startTeamsCaptionObserver();
              } else {
                startGmeetCaptionObserver();
              }
              updateStateView('RECORDING');
            });
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
      if (captureMode === 'gmeet' || captureMode === 'teams') {
        // Stop observer
        if (captureMode === 'teams') {
          stopTeamsCaptionObserver();
        } else {
          stopGmeetCaptionObserver();
        }
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
        if (captureMode === 'gmeet' || captureMode === 'teams') {
          // Stop observer
          if (captureMode === 'teams') {
            stopTeamsCaptionObserver();
          } else {
            stopGmeetCaptionObserver();
          }
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
  function updateStateView(state, errorMsg = null, summaryData = null) {
    activeState = state;

    const startBtn = document.getElementById('scribe-start-btn');
    const pauseBtn = document.getElementById('scribe-pause-btn');
    const stopBtn = document.getElementById('scribe-stop-btn');
    const cancelBtn = document.getElementById('scribe-cancel-btn');
    const statusText = document.getElementById('scribe-status-text');
    const exportContainer = document.getElementById('scribe-export-container');

    if (!startBtn || !stopBtn) return;

    const t = {
      vi: {
        startRec: '🔴 Bắt đầu Ghi',
        pauseRec: '⏸️ Tạm dừng',
        resumeRec: '▶️ Tiếp tục'
      },
      en: {
        startRec: '🔴 Start Recording',
        pauseRec: '⏸️ Pause',
        resumeRec: '▶️ Resume'
      }
    }[uiLanguage] || {
      startRec: '🔴 Bắt đầu Ghi',
      pauseRec: '⏸️ Tạm dừng',
      resumeRec: '▶️ Tiếp tục'
    };

    if (statusText) {
      // Reset indicator classes
      statusText.className = 'scribe-status-badge ' + state.toLowerCase();
      statusText.textContent = state;
    }

    switch (state) {
      case 'RECORDING':
        startBtn.style.display = 'none';
        startBtn.disabled = true;
        if (pauseBtn) {
          pauseBtn.style.display = 'flex';
          pauseBtn.textContent = t.pauseRec;
        }
        stopBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = 'flex';
        if (statusText) statusText.textContent = 'Recording';
        if (exportContainer) exportContainer.style.display = 'none';
        break;

      case 'PAUSED':
        startBtn.style.display = 'flex';
        startBtn.disabled = false;
        startBtn.textContent = t.resumeRec;
        if (pauseBtn) {
          pauseBtn.style.display = 'none';
        }
        stopBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = 'flex';
        if (statusText) statusText.textContent = 'Paused';
        if (exportContainer) exportContainer.style.display = 'block';
        break;

      case 'SUMMARIZING':
        startBtn.style.display = 'flex';
        startBtn.disabled = true;
        if (pauseBtn) pauseBtn.style.display = 'none';
        stopBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (statusText) statusText.textContent = 'Summarizing';
        if (exportContainer) exportContainer.style.display = 'none';
        showLoadingSpinner('Synthesizing Meeting Intelligence...', 'Gemini is compiling topic segments & rolling summaries.');
        switchTab('SUMMARY');
        break;

      case 'COMPLETED':
        startBtn.style.display = 'flex';
        startBtn.disabled = false;
        startBtn.textContent = t.startRec;
        if (pauseBtn) pauseBtn.style.display = 'none';
        stopBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (statusText) statusText.textContent = 'Done';
        if (exportContainer) exportContainer.style.display = 'none';
        
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
        startBtn.style.display = 'flex';
        startBtn.disabled = false;
        startBtn.textContent = t.startRec;
        if (pauseBtn) pauseBtn.style.display = 'none';
        stopBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'flex';
        if (statusText) statusText.textContent = 'Error';
        if (exportContainer) exportContainer.style.display = 'none';
        showErrorPanel(errorMsg || 'A system capture error occurred.');
        break;

      case 'IDLE':
      default:
        startBtn.style.display = 'flex';
        startBtn.disabled = false;
        startBtn.textContent = t.startRec;
        if (pauseBtn) pauseBtn.style.display = 'none';
        stopBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (statusText) statusText.textContent = 'Idle';
        if (exportContainer) exportContainer.style.display = 'none';
        
        // Reset live logs box
        const liveBoxIdle = document.getElementById('scribe-live-box');
        if (liveBoxIdle) {
          liveBoxIdle.innerHTML = '<div class="scribe-transcript-empty">No audio transcribed yet. Click Start to begin capturing.</div>';
        }
        // Reset summary box
        const summaryViewIdle = document.getElementById('scribe-summary-view');
        if (summaryViewIdle) {
          summaryViewIdle.innerHTML = '<div class="scribe-transcript-empty">No intelligence reports compiled yet. Complete a recording session to generate reports.</div>';
        }
        break;
    }
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
        <!-- Top Action Bar for Export Report -->
        <div style="display: flex; justify-content: flex-end; margin-bottom: 16px;">
          <button id="scribe-export-report-btn" class="scribe-export-btn" style="background: linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%); color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 13px; display: flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.2);">
            📄 Xuất báo cáo
          </button>
        </div>

        <!-- Topics Section -->
        <section class="scribe-summary-section">
          <h3 class="scribe-section-title">${t.topicsTitle}</h3>
          ${topicsHtml}
        </section>

        <!-- Decisions Section -->
        <section class="scribe-summary-section">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 8px;">
            <h3 class="scribe-section-title" style="margin-bottom: 0;">${t.decisionsTitle}</h3>
            <button id="scribe-export-excel-btn" class="scribe-export-btn" title="${t.exportTitle}">
              ${t.exportExcel}
            </button>
          </div>
          ${decisionsHtml}
        </section>

        <!-- Difficulties Section -->
        <section class="scribe-summary-section">
          <h3 class="scribe-section-title">${t.difficultiesTitle}</h3>
          ${difficultiesHtml}
        </section>

        <!-- Action Items Section -->
        <section class="scribe-summary-section">
          <h3 class="scribe-section-title" style="margin-bottom: 12px;">${t.actionsTitle}</h3>
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

    // Bind Export Report event
    const exportReportBtn = document.getElementById('scribe-export-report-btn');
    if (exportReportBtn) {
      exportReportBtn.addEventListener('click', () => {
        exportSummaryAsHTML(data);
      });
    }
  }

/**
 * Generates a standalone HTML report from the AI summary JSON.
 *
 * JSON Field Mapping (from geminiService.js schema):
 * - summary.topics[]        → { title: string, summary: string }
 * - summary.decisions[]     → string[]
 * - summary.difficulties[]  → { id: string, title: string, description: string, raisedBy: string }
 * - summary.actionItems[]   → { task: string, assignee: string, deadline: string }
 *
 * DOM State Reading:
 * - Action Item status  → .scribe-action-status[data-task] select (user-selected value)
 * - AI Suggestion text  → #difficulty-card-{id} .scribe-ai-suggestion-text (textContent)
 * - AI Citation text    → #difficulty-card-{id} .scribe-ai-citation-content (textContent)
 * - Loading guard       → checks both known loading strings AND presence of .scribe-spinner
 */
function exportSummaryAsHTML(summary) {
  // ─── Timestamp & Filename ────────────────────────────────────────────────
  const now = new Date();
  const dateStr = now.toLocaleDateString('vi-VN');
  const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const filename = [
    'MeetingReport',
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-') + '_' + [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0')
  ].join('-') + '.html';

  // ─── Loading State Guard ─────────────────────────────────────────────────
  // All known loading strings across both UI languages
  const LOADING_STRINGS = ['Thinking...', 'Đang xử lý...'];

  function isSuggestionLoading(cardEl) {
    if (!cardEl) return false;
    // Guard 1: spinner DOM element still present
    if (cardEl.querySelector('.scribe-spinner')) return true;
    // Guard 2: text matches any known loading string
    const textEl = cardEl.querySelector('.scribe-ai-suggestion-text');
    if (!textEl) return false;
    return LOADING_STRINGS.some(s => textEl.textContent.includes(s));
  }

  // ─── Section 1: Topics ───────────────────────────────────────────────────
  let topicsHtml = '';
  if (summary.topics && summary.topics.length > 0) {
    const items = summary.topics.map(t => `
      <li class="card topic-card">
        <strong class="topic-title">${escapeHtml(t.title)}</strong>
        <p class="topic-summary">${escapeHtml(t.summary)}</p>
      </li>
    `).join('');
    topicsHtml = `<ol class="topic-list">${items}</ol>`;
  } else {
    topicsHtml = '<p class="empty">Không có nội dung</p>';
  }

  // ─── Section 2: Decisions ────────────────────────────────────────────────
  let decisionsHtml = '';
  if (summary.decisions && summary.decisions.length > 0) {
    decisionsHtml = summary.decisions.map(d => `
      <div class="card decision-card">${escapeHtml(d)}</div>
    `).join('');
  } else {
    decisionsHtml = '<p class="empty">Không có quyết định</p>';
  }

  // ─── Section 3: Difficulties ─────────────────────────────────────────────
  let difficultiesHtml = '';
  if (summary.difficulties && summary.difficulties.length > 0) {
    difficultiesHtml = summary.difficulties.map(diff => {
      const cardEl = document.getElementById(`difficulty-card-${diff.id}`);

      // ── Suggestion text ──────────────────────────────────────────────────
      let suggestionText = 'Chưa có gợi ý từ SOP.';
      if (cardEl && !isSuggestionLoading(cardEl)) {
        const textEl = cardEl.querySelector('.scribe-ai-suggestion-text');
        const rawText = textEl ? textEl.textContent.trim() : '';
        if (rawText) suggestionText = rawText;
      }

      // ── Citation text (FIX: was missing entirely before) ─────────────────
      let citationText = '';
      if (cardEl) {
        const citationEl = cardEl.querySelector('.scribe-ai-citation-content');
        const rawCitation = citationEl ? citationEl.textContent.trim() : '';
        // Only include citation if suggestion container is visible (not hidden class)
        const citationBox = cardEl.querySelector('.scribe-ai-suggestion-citation');
        const citationVisible = citationBox && !citationBox.classList.contains('hidden');
        if (rawCitation && citationVisible) citationText = rawCitation;
      }

      return `
        <div class="card diff-card">
          <h4 class="diff-title">${escapeHtml(diff.title)}</h4>
          <p class="diff-description">${escapeHtml(diff.description)}</p>
          <div class="diff-meta">Nguồn: ${escapeHtml(diff.raisedBy || 'Không xác định')}</div>
          <div class="suggestion-box">
            <div class="suggestion-header">🤖 AI Suggestion (from SOP)</div>
            <div class="suggestion-body">${escapeHtml(suggestionText)}</div>
            ${citationText ? `
            <div class="citation-box">
              <span class="citation-label">📎 Trích dẫn SOP:</span>
              <em class="citation-text">${escapeHtml(citationText)}</em>
            </div>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } else {
    difficultiesHtml = '<p class="empty">Không có khó khăn</p>';
  }

  // ─── Section 4: Action Items ─────────────────────────────────────────────
  let actionItemsHtml = '';
  if (summary.actionItems && summary.actionItems.length > 0) {
    const rows = summary.actionItems.map((item, index) => {
      // Read live status from DOM dropdown — more reliable than item.status (not in schema)
      const selectEl = document.querySelector(`.scribe-action-status[data-task="${escapeHtml(item.task)}"]`);
      const currentStatus = selectEl ? selectEl.value : 'To Do';

      const badgeClassMap = {
        'To Do':       'badge-todo',
        'In Progress': 'badge-progress',
        'Done':        'badge-done'
      };
      const badgeClass = badgeClassMap[currentStatus] || 'badge-todo';

      return `
        <tr class="${index % 2 === 0 ? 'row-even' : 'row-odd'}">
          <td class="col-index">${index + 1}</td>
          <td class="col-task">${escapeHtml(item.task)}</td>
          <td class="col-assignee">${escapeHtml(item.assignee || 'Chưa phân công')}</td>
          <td class="col-deadline">${escapeHtml(item.deadline || 'Không xác định')}</td>
          <td class="col-status"><span class="badge ${badgeClass}">${escapeHtml(currentStatus)}</span></td>
        </tr>
      `;
    }).join('');

    actionItemsHtml = `
      <table>
        <thead>
          <tr>
            <th style="width: 40px;">#</th>
            <th>Công việc</th>
            <th style="width: 160px;">Người phụ trách</th>
            <th style="width: 140px;">Deadline</th>
            <th style="width: 110px;">Trạng thái</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } else {
    actionItemsHtml = '<p class="empty">Không có công việc cần làm</p>';
  }

  // ─── Full HTML Template ───────────────────────────────────────────────────
  const htmlContent = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Meeting Report – ${dateStr}</title>
  <style>
    /* ── Reset & Base ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 15px;
      color: #1a1a2e;
      background-color: #f4f6fb;
      line-height: 1.65;
    }

    /* ── Page Shell ── */
    .page-wrapper {
      max-width: 900px;
      margin: 40px auto;
      padding: 0 20px 60px;
    }

    /* ── Report Header ── */
    .report-header {
      background: #ffffff;
      border-radius: 12px;
      padding: 32px 36px;
      margin-bottom: 32px;
      border-bottom: 4px solid #4f46e5;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }
    .report-header h1 {
      font-size: 26px;
      font-weight: 700;
      color: #1a1a2e;
      letter-spacing: -0.3px;
    }
    .report-header .report-meta {
      margin-top: 8px;
      font-size: 13px;
      color: #6b7280;
    }
    .report-header .report-meta span {
      margin-right: 20px;
    }

    /* ── Section Card ── */
    .report-section {
      background: #ffffff;
      border-radius: 12px;
      padding: 28px 32px;
      margin-bottom: 24px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }

    .section-title {
      font-size: 16px;
      font-weight: 700;
      color: #4f46e5;
      padding-bottom: 12px;
      margin-bottom: 20px;
      border-bottom: 1px solid #e5e7eb;
      letter-spacing: -0.1px;
    }

    /* ── Generic Card ── */
    .card {
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 16px 18px;
      margin-bottom: 12px;
      background: #fafafa;
    }
    .card:last-child { margin-bottom: 0; }

    /* ── Topics ── */
    .topic-list {
      list-style: none;
      counter-reset: topic-counter;
      padding: 0;
    }
    .topic-card {
      counter-increment: topic-counter;
      padding-left: 52px;
      position: relative;
    }
    .topic-card::before {
      content: counter(topic-counter);
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      width: 26px;
      height: 26px;
      background: #4f46e5;
      color: #fff;
      border-radius: 50%;
      font-size: 12px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .topic-title {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: #1a1a2e;
      margin-bottom: 6px;
    }
    .topic-summary {
      font-size: 13px;
      color: #4b5563;
      margin: 0;
    }

    /* ── Decisions ── */
    .decision-card {
      border-left: 4px solid #4f46e5;
      font-size: 14px;
      color: #1a1a2e;
    }

    /* ── Difficulties ── */
    .diff-card {
      border-left: 4px solid #f59e0b;
    }
    .diff-title {
      font-size: 14px;
      font-weight: 600;
      color: #92400e;
      margin-bottom: 8px;
    }
    .diff-description {
      font-size: 13px;
      color: #4b5563;
      margin-bottom: 10px;
    }
    .diff-meta {
      font-size: 12px;
      color: #9ca3af;
      margin-bottom: 14px;
    }

    /* ── AI Suggestion Box ── */
    .suggestion-box {
      background: #eef2ff;
      border: 1px solid #c7d2fe;
      border-radius: 8px;
      padding: 14px 16px;
    }
    .suggestion-header {
      font-size: 12px;
      font-weight: 700;
      color: #4338ca;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .suggestion-body {
      font-size: 13px;
      color: #312e81;
      line-height: 1.6;
    }

    /* ── Citation Box ── */
    .citation-box {
      margin-top: 12px;
      padding: 10px 12px;
      background: rgba(52, 211, 153, 0.08);
      border: 1px dashed rgba(52, 211, 153, 0.5);
      border-radius: 6px;
    }
    .citation-label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      color: #065f46;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .citation-text {
      font-size: 12px;
      color: #047857;
      font-style: italic;
      line-height: 1.5;
    }

    /* ── Action Items Table ── */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      border: 1px solid #e5e7eb;
      padding: 11px 14px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #f3f4f6;
      font-weight: 600;
      color: #374151;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .row-even { background: #ffffff; }
    .row-odd  { background: #f9fafb; }
    .col-index { color: #9ca3af; font-size: 12px; text-align: center; vertical-align: middle; }

    /* ── Status Badge ── */
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .badge-todo     { background: #f3f4f6; color: #4b5563; }
    .badge-progress { background: #dbeafe; color: #1d4ed8; }
    .badge-done     { background: #dcfce7; color: #15803d; }

    /* ── Empty State ── */
    .empty {
      color: #9ca3af;
      font-style: italic;
      font-size: 13px;
      padding: 4px 0;
    }

    /* ── Print Overrides ── */
    @media print {
      body { background: #fff; }
      .page-wrapper { margin: 0; padding: 0; }
      .report-section { box-shadow: none; border: 1px solid #e5e7eb; }
      .card { page-break-inside: avoid; }
      tr   { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="page-wrapper">

    <div class="report-header">
      <h1>📋 Company Meeting Report</h1>
      <div class="report-meta">
        <span>📅 Ngày: ${dateStr}</span>
        <span>⏰ Giờ: ${timeStr}</span>
        <span>⚙️ Tạo bởi: Scribe AI</span>
      </div>
    </div>

    <section class="report-section">
      <h2 class="section-title">📋 Chủ đề thảo luận</h2>
      ${topicsHtml}
    </section>

    <section class="report-section">
      <h2 class="section-title">✅ Quyết định</h2>
      ${decisionsHtml}
    </section>

    <section class="report-section">
      <h2 class="section-title">⚠️ Khó khăn & Rủi ro</h2>
      ${difficultiesHtml}
    </section>

    <section class="report-section">
      <h2 class="section-title">📌 Action Items</h2>
      ${actionItemsHtml}
    </section>

  </div>
</body>
</html>`;

  // ─── Trigger Download ─────────────────────────────────────────────────────
  const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

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

  // =========================================================================
  // Microsoft Teams Captions Observer
  // =========================================================================
  let teamsObserver = null;

  function startTeamsCaptionObserver() {
    stopTeamsCaptionObserver();
    lastCaptionTexts.clear();

    console.log('[Scribe Teams] Starting MS Teams caption observer...');

    setTimeout(() => {
      // Find the MS Teams caption container, default to body if specific wrapper not found
      const captionContainer = document.querySelector('[data-tid="closed-caption-text"]')?.closest('.ui-box') || document.body;

      console.log('[Scribe Teams] Attaching MutationObserver...');
      appendLiveTranscript('✅ Đã kết nối với phụ đề MS Teams. Đang lắng nghe...');

      scanExistingTeamsCaptions(captionContainer);

      teamsObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.classList?.contains('fui-ChatMessageCompact')) {
                  processTeamsCaptionBlock(node);
                } else {
                  const blocks = node.querySelectorAll('.fui-ChatMessageCompact');
                  blocks.forEach(processTeamsCaptionBlock);
                }
              }
            });
          }
          if (mutation.type === 'characterData') {
            const parentEl = mutation.target.parentElement;
            if (parentEl) {
              const speakerBlock = parentEl.closest('.fui-ChatMessageCompact');
              if (speakerBlock) {
                processTeamsCaptionBlock(speakerBlock);
              }
            }
          }
        }
      });

      teamsObserver.observe(captionContainer, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }, 400);
  }

  function stopTeamsCaptionObserver() {
    if (teamsObserver) {
      teamsObserver.disconnect();
      teamsObserver = null;
      console.log('[Scribe Teams] MutationObserver disconnected.');
    }
    lastCaptionTexts.clear();
  }

  function scanExistingTeamsCaptions(container) {
    const blocks = container.querySelectorAll('.fui-ChatMessageCompact');
    Array.from(blocks).forEach(processTeamsCaptionBlock);
  }

  function processTeamsCaptionBlock(block) {
    let textEl = block.querySelector('[data-tid="closed-caption-text"]');
    let nameEl = block.querySelector('[data-tid="author"]');

    if (!textEl) return;

    const currentText = textEl.textContent.trim();
    const speaker = nameEl ? nameEl.textContent.trim() : 'Unknown';
    if (!currentText) return;

    const blockKey = generateTeamsBlockKey(block);
    const previousText = lastCaptionTexts.get(blockKey);

    if (currentText !== previousText) {
      lastCaptionTexts.set(blockKey, currentText);
      appendGmeetCaption(speaker, currentText, blockKey);
      saveCaptionToStorage(blockKey, speaker, currentText);
    }
  }

  function generateTeamsBlockKey(block) {
    if (block.dataset.scribeKey) return block.dataset.scribeKey;
    const key = 'teams_' + Date.now() + '_' + Math.random().toString(36).substring(2,9);
    block.dataset.scribeKey = key;
    return key;
  }

  /**
   * Append or update a Google Meet caption entry in the Live Logs panel with speaker badge.
   * Matches caption blocks by blockKey to allow real-time text updates in-place.
   */
  function appendGmeetCaption(speaker, text, blockKey) {
    if (activeState === 'PAUSED') return;
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
  }

  /**
   * Persist scraped caption text into IndexedDB via background worker for summarization.
   */
  function saveCaptionToStorage(blockKey, speaker, text) {
    if (activeState === 'PAUSED') return;
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
        showCropToolbar(rectX, rectY, rectW, rectH, img, dpr);
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

  function showCropToolbar(x, y, w, h, img, dpr) {
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
      await executeVisionAction('extract', x, y, w, h, img, 'vi', dpr);
    };

    const transBtn = toolbar.querySelector('#scribe-crop-trans');
    transBtn.onclick = async (e) => {
      e.stopPropagation();
      const lang = toolbar.querySelector('#scribe-crop-lang').value;
      await executeVisionAction('translate', x, y, w, h, img, lang, dpr);
    };

    activeCropToolbar = toolbar;
  }

  async function executeVisionAction(mode, x, y, w, h, img, targetLang, dpr) {
    try {
      const toolbar = activeCropToolbar;
      if (toolbar) {
        toolbar.innerHTML = `
          <div class="scribe-spinner" style="width: 20px; height: 20px; border-width: 2px; border-top-color: #a855f7;"></div>
          <span style="font-size:12px; font-weight:500; color: #ffffff;">Đang phân tích bằng Gemini...</span>
        `;
      }

      const dprScale = dpr || window.devicePixelRatio || 1;
      const cropCanvas = document.createElement('canvas');
      // Output canvas stays at CSS pixel size (controls file size sent to API)
      cropCanvas.width = w;
      cropCanvas.height = h;
      const cropCtx = cropCanvas.getContext('2d');
      // Source coordinates must be scaled to physical pixels
      cropCtx.drawImage(
        img,
        x * dprScale,       // source x in physical pixels
        y * dprScale,       // source y in physical pixels
        w * dprScale,       // source width in physical pixels
        h * dprScale,       // source height in physical pixels
        0, 0, w, h          // destination: CSS pixel canvas
      );
      
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
