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
  let isMinimized = false;
  let dragOffset = { x: 0, y: 0 };
  let isDragging = false;
  let overlayEl = null;
  let gmeetObserver = null; // MutationObserver for Google Meet captions
  let lastCaptionTexts = new Map(); // Track last known text per speaker block to detect changes

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
    chrome.storage.local.get(['recordingState', 'recordingError', 'finalSummary', 'captureMode'], (data) => {
      activeState = data.recordingState || 'IDLE';
      captureMode = data.captureMode || 'websocket';
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
    const handle = overlayEl.querySelector('.scribe-header');
    if (!handle) return;

    handle.addEventListener('mousedown', (e) => {
      // Ignore clicks on header action buttons
      if (e.target.closest('.scribe-btn-header')) return;
      if (isMinimized) return;

      isDragging = true;
      dragOffset.x = e.clientX - overlayEl.offsetLeft;
      dragOffset.y = e.clientY - overlayEl.offsetTop;
      
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', stopDrag);
    });

    function onDrag(e) {
      if (!isDragging) return;
      
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
    if (isMinimized) {
      overlayEl.className = 'gemini-scribe-overlay minimized';
      overlayEl.innerHTML = `<div class="scribe-logo" title="Gemini Scribe Dashboard">✨</div>`;
      
      overlayEl.onclick = () => {
        if (!checkContextValidity()) return;
        isMinimized = false;
        renderPanelLayout();
        // Restore active states
        chrome.storage.local.get(['recordingState', 'recordingError', 'finalSummary'], (data) => {
          updateStateView(data.recordingState || 'IDLE', data.recordingError, data.finalSummary);
        });
      };
      return;
    }

    // Full Expanded Layout
    overlayEl.className = 'gemini-scribe-overlay';
    overlayEl.onclick = null; // Remove minimize expand trigger
    
    overlayEl.innerHTML = `
      <!-- Draggable Header -->
      <header class="scribe-header">
        <div class="scribe-header-title">
          <span class="scribe-logo">✨</span>
          <span class="scribe-title-text">Gemini Scribe</span>
        </div>
        <div class="scribe-header-actions">
          <button class="scribe-btn-header" id="scribe-minimize-btn" title="Minimize Panel">➖</button>
        </div>
      </header>

      <!-- Main Body panel -->
      <div class="scribe-body">
        <!-- Capture Mode Selector -->
        <div style="padding: 16px 20px 4px 20px;">
          <div class="scribe-mode-selector">
            <label class="scribe-mode-label">📡 Capture Mode</label>
            <select id="scribe-capture-mode" class="scribe-mode-dropdown">
              <option value="websocket">🎙️ WebSocket STT (Deepgram)</option>
              <option value="gmeet">📋 Lấy theo Google Meet</option>
            </select>
          </div>
        </div>

        <!-- Control buttons row -->
        <div style="padding: 8px 20px 8px 20px;">
          <div class="scribe-actions-row">
            <button id="scribe-start-btn" class="scribe-btn scribe-btn-start">🔴 Start Recording</button>
            <button id="scribe-stop-btn" class="scribe-btn scribe-btn-stop" disabled>⏹️ Stop & Summary</button>
            <button id="scribe-cancel-btn" class="scribe-btn scribe-btn-cancel" style="display: none; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5;">❌ Hủy bỏ</button>
          </div>
        </div>

        <!-- Navigation Tabs -->
        <nav class="scribe-tabs">
          <div class="scribe-tab active" id="scribe-tab-transcript">Live Logs</div>
          <div class="scribe-tab" id="scribe-tab-summary">AI Summary</div>
        </nav>

        <!-- Dynamic Panels -->
        <div class="scribe-panel-content" id="scribe-panel-transcript">
          <div class="scribe-transcript-box" id="scribe-live-box" style="height: 330px;">
            <div class="scribe-transcript-empty">No audio transcribed yet. Click Start to begin capturing.</div>
          </div>
        </div>

        <div class="scribe-panel-content hidden" id="scribe-panel-summary">
          <!-- Summary Container -->
          <div id="scribe-summary-view" class="scribe-summary-box">
            <div class="scribe-transcript-empty">No intelligence reports compiled yet. Complete a recording session to generate reports.</div>
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
    const startBtn = document.getElementById('scribe-start-btn');
    const stopBtn = document.getElementById('scribe-stop-btn');
    const tabTranscript = document.getElementById('scribe-tab-transcript');
    const tabSummary = document.getElementById('scribe-tab-summary');
    const modeSelect = document.getElementById('scribe-capture-mode');

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

    // Minimize event
    minimizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      isMinimized = true;
      renderPanelLayout();
    });

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
    if (isMinimized) return; // Ignore updates if hidden

    const startBtn = document.getElementById('scribe-start-btn');
    const stopBtn = document.getElementById('scribe-stop-btn');
    const cancelBtn = document.getElementById('scribe-cancel-btn');
    const statusText = document.getElementById('scribe-status-text');

    if (!startBtn || !stopBtn) return;

    if (statusText) {
      // Reset indicator classes
      statusText.className = 'scribe-status-badge ' + state.toLowerCase();
      statusText.textContent = state;
    }

    switch (state) {
      case 'RECORDING':
        startBtn.disabled = true;
        stopBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = 'flex';
        if (statusText) statusText.textContent = 'Recording';
        
        // Clear previous transcripts on recording start
        const liveBox = document.getElementById('scribe-live-box');
        if (liveBox) {
          liveBox.innerHTML = '';
        }
        break;

      case 'SUMMARIZING':
        startBtn.disabled = true;
        stopBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (statusText) statusText.textContent = 'Summarizing';
        showLoadingSpinner('Synthesizing Meeting Intelligence...', 'Gemini is compiling topic segments & rolling summaries.');
        switchTab('SUMMARY');
        break;

      case 'COMPLETED':
        startBtn.disabled = false;
        stopBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (statusText) statusText.textContent = 'Done';
        
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
        if (statusText) statusText.textContent = 'Error';
        showErrorPanel(errorMsg || 'A system capture error occurred.');
        break;

      case 'IDLE':
      default:
        startBtn.disabled = false;
        stopBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (statusText) statusText.textContent = 'Idle';
        
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
    if (isMinimized) return;

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
      topicsHtml = '<div class="scribe-transcript-empty">No structured topics extracted.</div>';
    }

    // 2. Build Decisions Section
    let decisionsHtml = '';
    if (data.decisions && data.decisions.length > 0) {
      data.decisions.forEach((dec) => {
        decisionsHtml += `<div class="scribe-decision-item">${escapeHtml(dec)}</div>`;
      });
    } else {
      decisionsHtml = '<div class="scribe-transcript-empty">No decisions explicitly agreed.</div>';
    }

    // 3. Build Action Items Section
    let actionsHtml = '';
    if (data.actionItems && data.actionItems.length > 0) {
      data.actionItems.forEach((action) => {
        const assignee = action.assignee || 'Unassigned';
        const deadline = action.deadline || 'Not specified';
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
      actionsHtml = '<div class="scribe-transcript-empty">No direct action items assigned.</div>';
    }

    // Compile into dashboard bento layout
    summaryView.innerHTML = `
      <!-- Topics Section -->
      <section class="scribe-summary-section">
        <h3 class="scribe-section-title">📌 Key Topics Discussed</h3>
        ${topicsHtml}
      </section>

      <!-- Decisions Section -->
      <section class="scribe-summary-section">
        <h3 class="scribe-section-title">🎯 Agreements & Decisions</h3>
        ${decisionsHtml}
      </section>

      <!-- Action Items Section -->
      <section class="scribe-summary-section">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 8px;">
          <h3 class="scribe-section-title" style="margin-bottom: 0;">🚀 Tasks & Action Items</h3>
          <button id="scribe-export-excel-btn" class="scribe-export-btn" title="Xuất danh sách sang Microsoft Excel">
            📥 Xuất Excel
          </button>
        </div>
        ${actionsHtml}
      </section>
    `;

    // Bind Export Excel event
    const exportBtn = document.getElementById('scribe-export-excel-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const statusSelects = document.querySelectorAll('.scribe-action-status');
        if (statusSelects.length === 0) {
          alert('Không có Task & Action items nào để xuất!');
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
   * Start observing Google Meet's caption container for real-time text changes.
   */
  function startGmeetCaptionObserver() {
    // Clean up any previous observer
    stopGmeetCaptionObserver();
    lastCaptionTexts.clear();

    console.log('[Scribe GMeet] Starting Google Meet caption observer...');

    // Find the caption region container
    const captionContainer = document.querySelector('div[role="region"][aria-label="Phụ đề"]')
                          || document.querySelector('div[role="region"][aria-label="Captions"]')
                          || document.querySelector('div.vNKgIf');

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
            const speakerBlock = parentEl.closest('.nMcdL');
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
    const blocks = container.querySelectorAll('.nMcdL');
    blocks.forEach((block) => {
      const textEl = block.querySelector('.ygicle.VbkSUe');
      const nameEl = block.querySelector('span.NWpY1d');
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

    const textEl = block.querySelector('.ygicle.VbkSUe');
    const nameEl = block.querySelector('span.NWpY1d');
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
    const nameEl = block.querySelector('span.NWpY1d');
    const imgEl = block.querySelector('img.Z6byG');
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
    if (isMinimized) return;

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

})();
