/**
 * popup/popup.js
 * Controls settings saving, API key mask toggling, and broadcasts session resets.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Explicitly declare other DOM elements to prevent implicit global resolution issues
  const apiKeyInput = document.getElementById('api-key');
  const deepgramKeyInput = document.getElementById('deepgram-key');
  const modelSelect = document.getElementById('gemini-model');
  const wsUrlInput = document.getElementById('ws-url');
  const uiLanguageSelect = document.getElementById('ui-language');
  const toggleKeyBtn = document.getElementById('toggle-key-visibility');
  const toggleDeepgramBtn = document.getElementById('toggle-deepgram-visibility');
  const saveBtn = document.getElementById('save-settings');
  const resetBtn = document.getElementById('reset-session');
  const statusBadge = document.getElementById('status-badge');
  const statusDetail = document.getElementById('status-detail');
  const toast = document.getElementById('toast');

  // Chat & SOP tab UI elements
  const tabBtnConfig = document.getElementById('tab-btn-config');
  const tabBtnChat = document.getElementById('tab-btn-chat');
  const tabBtnSop = document.getElementById('tab-btn-sop');
  const configTabContent = document.getElementById('config-tab-content');
  const chatTabContent = document.getElementById('chat-tab-content');
  const sopTabContent = document.getElementById('sop-tab-content');
  const chatLockedWarning = document.getElementById('chat-locked-warning');
  const chatActiveContainer = document.getElementById('chat-active-container');
  const chatHistory = document.getElementById('chat-history');
  const chatInput = document.getElementById('chat-input');
  const btnSendChat = document.getElementById('btn-send-chat');
  const sopRawText = document.getElementById('sop-raw-text');
  const sopFileUpload = document.getElementById('sop-file-upload');
  const saveSopBtn = document.getElementById('save-sop');

  // Microphone Permission UI Elements
  const micPermissionCard = document.getElementById('mic-permission-card');
  const btnGrantMic = document.getElementById('btn-grant-mic');
  const micPermissionTitle = document.getElementById('mic-permission-title');
  const micPermissionDesc = document.getElementById('mic-permission-desc');

  async function checkMicrophonePermission() {
    if (!navigator.permissions || !navigator.permissions.query) {
      // Fallback if query API is not supported in this context
      if (micPermissionCard) micPermissionCard.classList.add('hidden');
      return;
    }

    try {
      const permissionStatus = await navigator.permissions.query({ name: 'microphone' });
      console.log('Microphone permission state:', permissionStatus.state);
      handlePermissionState(permissionStatus.state);

      // Bind dynamic listener for permission status updates
      permissionStatus.onchange = () => {
        handlePermissionState(permissionStatus.state);
      };
    } catch (err) {
      console.warn('Permissions query failed:', err);
      if (micPermissionCard) micPermissionCard.classList.add('hidden');
    }
  }

  function handlePermissionState(state) {
    if (state === 'granted') {
      if (micPermissionCard) micPermissionCard.classList.add('hidden');
      chrome.storage.local.set({ micPermissionGranted: true });
    } else if (state === 'denied') {
      if (micPermissionCard) {
        micPermissionCard.classList.remove('hidden');
        micPermissionTitle.textContent = 'Microphone Access Blocked';
        micPermissionTitle.style.color = '#ef4444';
        micPermissionCard.style.background = 'rgba(239, 68, 68, 0.1)';
        micPermissionCard.style.borderColor = 'rgba(239, 68, 68, 0.3)';
        micPermissionDesc.innerHTML = 'Microphone access is blocked by your browser settings. Please click the site settings icon in the address bar and select "Allow" for microphone access.';
        btnGrantMic.style.display = 'none';
      }
      chrome.storage.local.set({ micPermissionGranted: false });
    } else {
      // state === 'prompt'
      if (micPermissionCard) {
        micPermissionCard.classList.remove('hidden');
        micPermissionTitle.textContent = 'Microphone Permission Required';
        micPermissionTitle.style.color = '#f59e0b';
        micPermissionCard.style.background = 'rgba(245, 158, 11, 0.1)';
        micPermissionCard.style.borderColor = 'rgba(245, 158, 11, 0.3)';
        micPermissionDesc.textContent = 'Scribe AI needs microphone access to record meeting audio. Please grant permission before recording.';
        btnGrantMic.style.display = 'inline-block';
      }
      chrome.storage.local.set({ micPermissionGranted: false });
    }
  }

  if (btnGrantMic) {
    btnGrantMic.addEventListener('click', async () => {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop());
          console.log('Microphone permission granted successfully.');
          handlePermissionState('granted');
          showToast('Microphone permission granted!');
        } catch (err) {
          console.warn('Microphone permission request rejected:', err);
          if (err.name === 'NotAllowedError') {
            handlePermissionState('denied');
            showToast('Microphone permission blocked.', true);
          } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            if (micPermissionDesc) {
              micPermissionDesc.textContent = 'No audio input devices found. Please check your physical connection.';
            }
            showToast('No microphone found.', true);
          } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
            if (micPermissionDesc) {
              micPermissionDesc.textContent = 'Microphone is already in use by another application or OS.';
            }
            showToast('Microphone hardware error or conflict.', true);
          } else {
            showToast('Permission request failed: ' + err.message, true);
          }
        }
      }
    });
  }

  // Trigger permission check on load
  checkMicrophonePermission();

  // Load current configuration and state
  chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'deepgramApiKey', 'websocketUrl', 'uiLanguage', 'recordingState', 'recordingError', 'sopRawText'], (data) => {
    if (data.geminiModel) {
      modelSelect.value = data.geminiModel;
    } else {
      modelSelect.value = 'gemini-3.1-flash-lite-preview';
    }
    if (data.websocketUrl) {
      wsUrlInput.value = data.websocketUrl;
    } else {
      wsUrlInput.value = 'ws://localhost:8080/stt';
    }
    if (data.uiLanguage) {
      uiLanguageSelect.value = data.uiLanguage;
    } else {
      uiLanguageSelect.value = 'vi';
    }
    
    updateStateUI(data.recordingState || 'IDLE', data.recordingError);

    // Load plaintext keys directly
    if (data.geminiApiKey) {
      apiKeyInput.value = data.geminiApiKey;
    }
    if (data.deepgramApiKey) {
      deepgramKeyInput.value = data.deepgramApiKey;
    }
    if (data.sopRawText && sopRawText) {
      sopRawText.value = data.sopRawText;
    }
    
    refreshChatTabUI();
    
    // Restore persistent chat history from IndexedDB
    if (window.meetingDB && typeof window.meetingDB.getAllChatMessages === 'function') {
      window.meetingDB.getAllChatMessages()
        .then((messages) => {
          if (messages && messages.length > 0) {
            chatHistory.innerHTML = '';
            messages.forEach((msg) => {
              appendChatBubble(msg.text, msg.role === 'user' ? 'user' : 'assistant');
            });
            chatHistory.scrollTop = chatHistory.scrollHeight;
          }
        })
        .catch((err) => {
          console.error('Failed to load past chat history:', err);
        });
    }
  });

  // Periodically poll or listen for state changes to keep popup reactive
  setInterval(() => {
    chrome.storage.local.get(['recordingState', 'recordingError'], (data) => {
      updateStateUI(data.recordingState || 'IDLE', data.recordingError);
    });
  }, 1000);

  // Toggle API key visibility mask
  toggleKeyBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyBtn.textContent = '🙈';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyBtn.textContent = '👁️';
    }
  });

  // Toggle Deepgram key visibility mask
  toggleDeepgramBtn.addEventListener('click', () => {
    if (deepgramKeyInput.type === 'password') {
      deepgramKeyInput.type = 'text';
      toggleDeepgramBtn.textContent = '🙈';
    } else {
      deepgramKeyInput.type = 'password';
      toggleDeepgramBtn.textContent = '👁️';
    }
  });

  // Save Settings handler
  saveBtn.addEventListener('click', async () => {
    const rawApiKey = apiKeyInput.value.trim();
    const rawDeepgramKey = deepgramKeyInput.value.trim();
    const rawWsUrl = wsUrlInput.value.trim();
    const selectedModel = modelSelect.value;

    // 1. Strict Validation
    if (!rawApiKey) {
      showToast('Error: Gemini API Key is required.', true);
      return;
    }

    if (!rawApiKey.startsWith('AIzaSy') && rawApiKey !== '••••••••••••••••••••••••••••••••') {
      showToast('Warning: API Key does not appear to be a valid Gemini key format.', true);
    }

    if (!rawWsUrl) {
      showToast('Error: WebSocket STT URL is required.', true);
      return;
    }

    if (!rawWsUrl.startsWith('ws://') && !rawWsUrl.startsWith('wss://')) {
      showToast('Error: URL must begin with ws:// or wss://', true);
      return;
    }

    try {
      // 2. Persist to Chrome Local Storage
      chrome.storage.local.set({
        geminiApiKey: rawApiKey,
        geminiModel: selectedModel,
        deepgramApiKey: rawDeepgramKey,
        websocketUrl: rawWsUrl,
        uiLanguage: uiLanguageSelect.value
      }, async () => {
        // Cache plaintext key in memory if we have session storage
        if (chrome.storage.session) {
          if (chrome.storage.session.setAccessLevel) {
            await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
          }
          chrome.storage.session.set({
            geminiApiKey: rawApiKey,
            deepgramApiKey: rawDeepgramKey
          });
        }

        refreshChatTabUI();
        showToast('Settings saved successfully!');
        console.log('Saved configuration.');
      });
    } catch (err) {
      console.error('Save failed:', err);
      showToast('Error saving settings: ' + err.message, true);
    }
  });

  // Reset Session handler
  resetBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear current transcript data and reset meeting status?')) {
      chrome.runtime.sendMessage({ action: 'RESET_MEETING_SESSION' }, (response) => {
        if (response && response.success) {
          showToast('Session reset successfully.');
          updateStateUI('IDLE');
          if (chatHistory) {
            chatHistory.innerHTML = '';
          }
        } else {
          showToast('Reset failed: ' + (response?.error || 'Unknown error'), true);
        }
      });
    }
  });

  /**
   * Refreshes the visual badge and text based on active recording state.
   */
  function updateStateUI(state, errorMsg = null) {
    statusBadge.className = 'badge ' + state.toLowerCase();
    statusBadge.textContent = state;

    switch (state) {
      case 'RECORDING':
        statusDetail.textContent = 'Streaming captured audio to STT server...';
        resetBtn.disabled = true;
        break;
      case 'PAUSED':
        statusDetail.textContent = 'Recording is paused. Capturing is temporarily suspended.';
        resetBtn.disabled = true;
        break;
      case 'SUMMARIZING':
        statusDetail.textContent = 'Synthesizing rolling summaries in Gemini API...';
        resetBtn.disabled = true;
        break;
      case 'COMPLETED':
        statusDetail.textContent = 'Intelligence reports generated! View results on page panel.';
        resetBtn.disabled = false;
        break;
      case 'ERROR':
        statusDetail.textContent = `Error: ${errorMsg || 'A pipeline failure occurred.'}`;
        resetBtn.disabled = false;
        break;
      case 'IDLE':
      default:
        statusDetail.textContent = 'Ready to capture meeting audio.';
        resetBtn.disabled = false;
        break;
    }
  }

  /**
   * Triggers a temporary glassmorphic feedback alert bubble.
   */
  function showToast(text, isError = false) {
    toast.textContent = text;
    if (isError) {
      toast.style.background = 'rgba(239, 68, 68, 0.95)';
    } else {
      toast.style.background = 'rgba(16, 185, 129, 0.95)';
    }
    
    toast.classList.remove('hidden');
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 2500);
  }

  // TAB SWITCHING HANDLERS
  tabBtnConfig.addEventListener('click', () => {
    tabBtnConfig.classList.add('active');
    tabBtnChat.classList.remove('active');
    if (tabBtnSop) tabBtnSop.classList.remove('active');
    configTabContent.classList.remove('hidden');
    chatTabContent.classList.add('hidden');
    if (sopTabContent) sopTabContent.classList.add('hidden');
  });

  tabBtnChat.addEventListener('click', () => {
    tabBtnChat.classList.add('active');
    tabBtnConfig.classList.remove('active');
    if (tabBtnSop) tabBtnSop.classList.remove('active');
    chatTabContent.classList.remove('hidden');
    configTabContent.classList.add('hidden');
    if (sopTabContent) sopTabContent.classList.add('hidden');
    refreshChatTabUI();
  });

  if (tabBtnSop) {
    tabBtnSop.addEventListener('click', () => {
      tabBtnSop.classList.add('active');
      tabBtnConfig.classList.remove('active');
      tabBtnChat.classList.remove('active');
      if (sopTabContent) sopTabContent.classList.remove('hidden');
      configTabContent.classList.add('hidden');
      chatTabContent.classList.add('hidden');
    });
  }

  // --- PDF Text Extraction via Native PDF.js Worker ---
  async function parsePdfText(arrayBuffer) {
    const statusDiv = document.getElementById('sop-processing-status');
    
    // Configure PDF.js to use the packaged local worker minified script
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('popup/lib/pdf.worker.min.js');
    
    const loadingTask = pdfjsLib.getDocument({
      data: arrayBuffer,
      disableEval: true, // Securely runs in Chrome Extension MV3 context without sandbox
      useSystemFonts: true
    });
    
    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;
    let fullText = '';
    
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      if (statusDiv) {
        const progress = Math.round((pageNum / numPages) * 100);
        statusDiv.classList.remove('hidden');
        statusDiv.style.color = '#60a5fa';
        statusDiv.innerHTML = `
          <span style="animation: scribe-float 1.5s ease-in-out infinite;">📂</span>
          <span>Extracting: Page ${pageNum}/${numPages} (${progress}%)</span>
        `;
      }
      
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map(item => item.str)
        .join(' ')
        .replace(/\s+/g, ' '); // Clean excessive whitespaces
        
      fullText += pageText + '\n\n';
    }
    
    return fullText.trim();
  }

  // --- Semantic Boundary Backtracking Chunking Algorithm ---
  function semanticChunkText(text, maxChunkSize = 50000, fallbackTolerance = 15000) {
    const chunks = [];
    let index = 0;
    const totalLength = text.length;

    while (index < totalLength) {
      if (totalLength - index <= maxChunkSize) {
        chunks.push(text.substring(index).trim());
        break;
      }

      let endPosition = index + maxChunkSize;
      let chosenCut = -1;

      // Backtracking boundary search range
      const minPosition = Math.max(index, endPosition - fallbackTolerance);
      const searchBlock = text.substring(minPosition, endPosition);

      // 1. Try paragraph break (\n\n)
      const lastParagraphBreak = searchBlock.lastIndexOf('\n\n');
      if (lastParagraphBreak !== -1) {
        chosenCut = minPosition + lastParagraphBreak + 2;
      } else {
        // 2. Try sentence boundary (. / ? / ! followed by space)
        const sentenceRegex = /[.!?]\s+/g;
        let match;
        let lastSentenceBoundary = -1;
        while ((match = sentenceRegex.exec(searchBlock)) !== null) {
          lastSentenceBoundary = match.index + match[0].length;
        }
        
        if (lastSentenceBoundary !== -1) {
          chosenCut = minPosition + lastSentenceBoundary;
        } else {
          // 3. Try word boundary (space)
          const lastSpace = searchBlock.lastIndexOf(' ');
          if (lastSpace !== -1) {
            chosenCut = minPosition + lastSpace + 1;
          } else {
            // 4. Force slice fallback
            chosenCut = endPosition;
          }
        }
      }

      chunks.push(text.substring(index, chosenCut).trim());
      index = chosenCut;
    }

    return chunks;
  }

  // --- Concurrency Queue with Exponential Backoff Retry ---
  class ConcurrencyQueue {
    constructor(maxConcurrency = 3, maxRetries = 3, initialDelayMs = 2000) {
      this.maxConcurrency = maxConcurrency;
      this.maxRetries = maxRetries;
      this.initialDelayMs = initialDelayMs;
    }

    async run(tasks, progressCallback) {
      let activeTasks = 0;
      let taskIndex = 0;
      let completedTasks = 0;
      const totalTasks = tasks.length;
      const results = new Array(totalTasks);

      return new Promise((resolve, reject) => {
        const next = () => {
          if (taskIndex >= totalTasks && activeTasks === 0) {
            return resolve(results);
          }

          while (activeTasks < this.maxConcurrency && taskIndex < totalTasks) {
            const currentIdx = taskIndex++;
            activeTasks++;
            
            this.executeWithRetry(tasks[currentIdx], 0)
              .then(res => {
                results[currentIdx] = res;
                activeTasks--;
                completedTasks++;
                
                if (progressCallback) {
                  progressCallback(completedTasks, totalTasks);
                }
                
                next();
              })
              .catch(err => {
                activeTasks--;
                reject(err);
              });
          }
        };

        next();
      });
    }

    async executeWithRetry(taskFn, attempt = 0) {
      try {
        return await taskFn();
      } catch (err) {
        const isRateLimit = err.status === 429 || 
                            (err.message && err.message.includes('429')) || 
                            (err.message && err.message.toLowerCase().includes('too many requests')) ||
                            (err.message && err.message.toLowerCase().includes('resource exhausted'));
        
        if (isRateLimit && attempt < this.maxRetries) {
          const delay = this.initialDelayMs * Math.pow(2, attempt);
          console.warn(`[Concurrency Queue] HTTP 429 rate limit encountered. Retrying task (attempt ${attempt + 1}/${this.maxRetries}) in ${delay}ms...`);
          await new Promise(res => setTimeout(res, delay));
          return this.executeWithRetry(taskFn, attempt + 1);
        }
        throw err;
      }
    }
  }

  // --- Refactored Divide and Conquer Large Document Analysis ---
  async function runDivideAndConquerSop(sopText) {
    const statusDiv = document.getElementById('sop-processing-status');
    if (statusDiv) {
      statusDiv.classList.remove('hidden');
      statusDiv.style.color = '#60a5fa';
      statusDiv.innerHTML = `
        <span style="animation: scribe-float 1.5s ease-in-out infinite;">⚡</span>
        <span>Analyzing document structure & compiling semantic boundary chunks...</span>
      `;
    }

    try {
      const apiKey = await window.geminiService.getSavedApiKey();
      
      // Split into boundary-respecting chunks
      const chunks = semanticChunkText(sopText, 50000, 15000);
      const totalChunks = chunks.length;
      console.log(`[Divide and Conquer] Generated ${totalChunks} semantic boundary chunks.`);

      if (statusDiv) {
        statusDiv.innerHTML = `
          <span style="animation: scribe-float 1.5s ease-in-out infinite;">⚙️</span>
          <span>Preparing ${totalChunks} parallel Gemini analyses...</span>
        `;
      }

      // Convert chunks into lazy executable tasks
      const tasks = chunks.map((chunkText, i) => {
        return async () => {
          const chunkPrompt = `Bạn là một chuyên gia phân tích quy trình nghiệp vụ cấp cao.
Dưới đây là phần ${i + 1}/${totalChunks} của tài liệu lớn được phân nhỏ theo thuật toán Chia để trị (Divide and Conquer). 
Nhiệm vụ của bạn là hãy phân tích và trích xuất chi tiết tất cả các hướng dẫn, quy định, quy trình và bước thực hiện quan trọng được đề cập trong phần này.
Vui lòng trình bày rõ ràng, chi tiết và súc tích để phục vụ cho việc hợp nhất toàn bộ tài liệu sau này.

[PHẦN TÀI LIỆU CẦN PHÂN TÍCH]
${chunkText}
`;
          return await window.geminiService.callGeminiApi(apiKey, chunkPrompt, false);
        };
      });

      // Instantiate local concurrent queue (max 3 concurrent jobs, 3 retries)
      const queue = new ConcurrencyQueue(3, 3, 2000);
      
      const intermediateSummaries = await queue.run(tasks, (completed, total) => {
        if (statusDiv) {
          statusDiv.innerHTML = `
            <span style="animation: scribe-float 1.5s ease-in-out infinite;">⚙️</span>
            <span>Analyzing chunks: ${completed}/${total} completed...</span>
          `;
        }
      });

      // Conquering phase: merge and consolidate
      if (statusDiv) {
        statusDiv.innerHTML = `
          <span style="animation: scribe-float 1.5s ease-in-out infinite;">🧬</span>
          <span>Consolidating summaries into final SOP standard...</span>
        `;
      }

      const consolidationPrompt = `Bạn là chuyên gia thiết lập tài liệu Quy trình vận hành tiêu chuẩn (SOP - Standard Operating Procedure) chuyên nghiệp.
Dưới đây là các phần tóm tắt quy trình được trích xuất từ một tài liệu lớn sử dụng thuật toán Chia để trị (Divide and Conquer).

Nhiệm vụ của bạn là:
1. Hợp nhất tất cả các phần tóm tắt quy trình ở trên thành một tài liệu quy trình vận hành chuẩn (SOP) hoàn chỉnh, có cấu trúc logic cực kỳ chặt chẽ.
2. Loại bỏ hoàn toàn các thông tin trùng lặp hoặc mâu thuẫn giữa các phần.
3. Trình bày tài liệu bằng Tiếng Việt (hoặc Tiếng Anh nếu toàn bộ dữ liệu gốc là Tiếng Anh) một cách chuyên nghiệp, sử dụng Markdown với các tiêu đề rõ ràng (H1, H2, H3), danh sách gạch đầu dòng chi tiết.
4. Đảm bảo giữ lại đầy đủ các bước kỹ thuật, hướng dẫn tác nghiệp và quy định cốt lõi.

[CÁC TÓM TẮT THÀNH PHẦN]
${intermediateSummaries.join('\n\n--- PHẦN TÀI LIỆU MỚI ---\n\n')}

[TÀI LIỆU SOP CUỐI CÙNG]
`;

      const finalConsolidatedSop = await window.geminiService.callGeminiApi(apiKey, consolidationPrompt, false);

      if (statusDiv) {
        statusDiv.style.color = '#34d399';
        statusDiv.innerHTML = `✅ Knowledge Base compiled & consolidated successfully!`;
        setTimeout(() => statusDiv.classList.add('hidden'), 5000);
      }

      return finalConsolidatedSop.trim();

    } catch (err) {
      console.error('[Divide and Conquer Error]', err);
      if (statusDiv) {
        statusDiv.style.color = '#f87171';
        statusDiv.innerHTML = `❌ Error: ${err.message}`;
      }
      throw err;
    }
  }

  // SOP Save Action
  if (saveSopBtn) {
    saveSopBtn.addEventListener('click', async () => {
      const text = sopRawText.value.trim();
      const file = sopFileUpload.files[0];
      const statusDiv = document.getElementById('sop-processing-status');

      // Size constraints check: maximum 30MB
      const maxFileSize = 30 * 1024 * 1024; // 30 Megabytes

      if (file) {
        if (file.size > maxFileSize) {
          showToast('Error: File size exceeds the maximum limit of 30MB.', true);
          return;
        }

        saveSopBtn.disabled = true;
        saveSopBtn.textContent = 'Processing Document...';

        const reader = new FileReader();
        const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';

        reader.onload = async (e) => {
          try {
            let extractedText = '';

            if (isPdf) {
              if (statusDiv) {
                statusDiv.classList.remove('hidden');
                statusDiv.style.color = '#60a5fa';
                statusDiv.innerHTML = `
                  <span style="animation: scribe-float 1.5s ease-in-out infinite;">📂</span>
                  <span>Extracting text from PDF via Web Worker...</span>
                `;
              }
              extractedText = await parsePdfText(e.target.result);
              if (!extractedText) {
                throw new Error('Could not extract any plain text from the PDF document.');
              }
            } else {
              extractedText = e.target.result;
            }

            // Run Divide and Conquer if extracted text is massive (> 50,000 characters)
            let processedText = extractedText;
            if (extractedText.length > 50000) {
              processedText = await runDivideAndConquerSop(extractedText);
            }

            chrome.storage.local.set({ sopRawText: processedText }, () => {
              if (sopRawText) sopRawText.value = processedText;
              showToast('Document uploaded and saved successfully!');
              console.log('Saved uploaded document as raw SOP text.');
              
              // Clear file input
              sopFileUpload.value = '';
              
              saveSopBtn.disabled = false;
              saveSopBtn.textContent = 'Save to Knowledge Base';
            });

          } catch (err) {
            console.error('[Document processing failed]', err);
            showToast('Processing failed: ' + err.message, true);
            saveSopBtn.disabled = false;
            saveSopBtn.textContent = 'Save to Knowledge Base';
            if (statusDiv) {
              statusDiv.style.color = '#f87171';
              statusDiv.innerHTML = `❌ Processing failed: ${err.message}`;
            }
          }
        };

        reader.onerror = () => {
          showToast('Error reading uploaded file.', true);
          saveSopBtn.disabled = false;
          saveSopBtn.textContent = 'Save to Knowledge Base';
        };

        if (isPdf) {
          reader.readAsArrayBuffer(file);
        } else {
          reader.readAsText(file);
        }

      } else {
        if (!text) {
          showToast('Error: Please enter text or upload a file.', true);
          return;
        }

        saveSopBtn.disabled = true;
        saveSopBtn.textContent = 'Saving...';

        try {
          let processedText = text;
          if (text.length > 50000) {
            processedText = await runDivideAndConquerSop(text);
          }

          chrome.storage.local.set({ sopRawText: processedText }, () => {
            if (sopRawText) sopRawText.value = processedText;
            showToast('SOP text saved successfully!');
            console.log('Saved raw SOP text configuration.');
            saveSopBtn.disabled = false;
            saveSopBtn.textContent = 'Save to Knowledge Base';
          });
        } catch (err) {
          showToast('Failed to save: ' + err.message, true);
          saveSopBtn.disabled = false;
          saveSopBtn.textContent = 'Save to Knowledge Base';
        }
      }
    });
  }

  // Refresh Chat view based on keys locked/unlocked state
  function refreshChatTabUI() {
    if (chatLockedWarning) {
      chatLockedWarning.classList.add('hidden');
    }
    chatActiveContainer.classList.remove('hidden');
  }

  // Chat message send handlers
  btnSendChat.addEventListener('click', triggerChatMessageSend);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      triggerChatMessageSend();
    }
  });

  /**
   * Creates an optimized, double-buffered, thread-safe token stream renderer.
   * Utilizes requestAnimationFrame to prevent layout thrashing and UI thread locks,
   * and uses a snapshot capture method to resolve race conditions.
   * @param {HTMLElement} domElement The target bubble's text placeholder node
   * @param {HTMLElement} containerElement The chat history scroll view container
   * @returns {Function} A thread-safe function to ingest streamed token fragments
   */
  function createTokenAppender(domElement, containerElement) {
    let accumulator = '';
    let pending = false;
    let isFirst = true;

    return (token) => {
      accumulator += token;

      if (!pending) {
        pending = true;

        requestAnimationFrame(() => {
          // 1. Thread-safe snapshot capture to avoid mid-frame race conditions
          const snapshot = accumulator;
          accumulator = '';
          pending = false;

          // 2. Clear visual thinking state on the very first resolved token
          if (isFirst) {
            domElement.textContent = '';
            isFirst = false;
          }

          // 3. Contiguous layout repaint mutation
          domElement.textContent += snapshot;

          // 4. Force smooth scroll alignment with layout update
          containerElement.scrollTop = containerElement.scrollHeight;
        });
      }
    };
  }

  async function triggerChatMessageSend() {
    const query = chatInput.value.trim();
    if (!query) return;

    // 1. Append User message bubble
    appendChatBubble(query, 'user');
    chatInput.value = '';

    // Scroll chat area to bottom
    chatHistory.scrollTop = chatHistory.scrollHeight;

    try {
      // 2. Fetch the compiled transcript from IndexedDB
      let transcriptText = '';
      if (window.meetingDB && typeof window.meetingDB.getCompiledTranscript === 'function') {
        transcriptText = await window.meetingDB.getCompiledTranscript();
      }

      // Fallback 1: lastCompiledTranscript in chrome.storage.local
      if (!transcriptText || transcriptText.trim() === '') {
        const localData = await new Promise(resolve => chrome.storage.local.get(['lastCompiledTranscript'], resolve));
        transcriptText = localData.lastCompiledTranscript || '';
      }

      // Fallback 2: Google Meet captions (Live Logs) from chrome.storage.local
      if (!transcriptText || transcriptText.trim() === '') {
        const localData = await new Promise(resolve => chrome.storage.local.get(['gmeetCaptions'], resolve));
        const captions = localData.gmeetCaptions;
        if (captions && typeof captions === 'object' && Object.keys(captions).length > 0) {
          // Convert to sorted array of caption segments based on timestamp
          const sortedCaptions = Object.values(captions).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          transcriptText = sortedCaptions.map(c => `${c.speaker || 'Unknown'}: ${c.text || ''}`).join('\n');
          console.log(`[RAG Fallback] Compiled ${sortedCaptions.length} live log caption segments.`);
        }
      }

      const uiLang = uiLanguageSelect.value || 'vi';

      if (!transcriptText || transcriptText.trim() === '') {
        const errorMsg = uiLang === 'vi'
          ? 'Không tìm thấy dữ liệu cuộc họp để trả lời. Vui lòng đảm bảo cuộc họp đã bắt đầu hoặc có thoại ghi nhận.'
          : 'No meeting data found to answer. Please make sure the meeting has started and generated dialogue.';
        appendChatBubble(errorMsg, 'assistant');
        chatHistory.scrollTop = chatHistory.scrollHeight;
        return;
      }

      // Save user message to IndexedDB before calling API
      if (window.meetingDB && typeof window.meetingDB.saveChatMessage === 'function') {
        await window.meetingDB.saveChatMessage('user', query);
      }

      // Retrieve Gemini parameters
      const apiKey = apiKeyInput.value.trim();

      // 3. Append temporary loading bubble
      const loadingBubble = appendChatBubble(uiLang === 'vi' ? 'Đang suy nghĩ...' : 'Thinking...', 'assistant');
      chatHistory.scrollTop = chatHistory.scrollHeight;

      // Fetch dynamic chat history to pass to API
      let history = [];
      if (window.meetingDB && typeof window.meetingDB.getAllChatMessages === 'function') {
        history = await window.meetingDB.getAllChatMessages();
      }

      // 4. Call geminiService.chatWithMeeting
      if (window.geminiService && typeof window.geminiService.chatWithMeeting === 'function') {
        const streamResponse = await window.geminiService.chatWithMeeting(apiKey, transcriptText, query, uiLang, history);
        
        const reader = streamResponse.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let fullAccumulatedText = '';

        const appendToken = createTokenAppender(loadingBubble, chatHistory);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          let braceCount = 0;
          let startIndex = -1;

          for (let i = 0; i < buffer.length; i++) {
            if (buffer[i] === '{') {
              if (braceCount === 0) {
                startIndex = i;
              }
              braceCount++;
            } else if (buffer[i] === '}') {
              braceCount--;
              if (braceCount === 0 && startIndex !== -1) {
                const jsonString = buffer.substring(startIndex, i + 1);
                try {
                  const chunkJson = JSON.parse(jsonString);
                  const textToken = chunkJson.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (textToken) {
                    fullAccumulatedText += textToken;
                    appendToken(textToken);
                  }
                } catch (e) {
                  console.warn("Failed to parse partial JSON chunk:", e);
                }
                buffer = buffer.substring(i + 1);
                i = -1;
                startIndex = -1;
              }
            }
          }
        }

        // Wait brief delay for any pending requestAnimationFrame frames to complete
        await new Promise(resolve => setTimeout(resolve, 50));

        // Save model message to IndexedDB
        if (window.meetingDB && typeof window.meetingDB.saveChatMessage === 'function') {
          await window.meetingDB.saveChatMessage('model', fullAccumulatedText || loadingBubble.textContent);
        }
      } else {
        loadingBubble.textContent = uiLang === 'vi' 
          ? 'Lỗi: Dịch vụ Gemini chưa được khởi tạo đúng cách.'
          : 'Error: Gemini service is not initialized properly.';
      }
    } catch (err) {
      console.error('Chat execution query failed:', err);
      appendChatBubble('Error: ' + err.message, 'assistant');
    }

    chatHistory.scrollTop = chatHistory.scrollHeight;
  }

  function appendChatBubble(text, sender) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${sender}-bubble`;
    
    const p = document.createElement('p');
    p.textContent = text;
    bubble.appendChild(p);
    
    chatHistory.appendChild(bubble);
    return p;
  }
});

// Hàm xin quyền Micro từ giao diện Popup
async function checkAndRequestMicrophonePermission() {
  try {
    // Ép Chrome hiện hộp thoại xin quyền Micro ở góc trái màn hình
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Nếu người dùng bấm "Allow", quyền đã được cấp. 
    // Ta phải tắt ngay luồng âm thanh ở Popup đi, để nhường lại cho Offscreen dùng.
    stream.getTracks().forEach(track => track.stop());
    
    // Ẩn bảng cảnh báo (nếu đang hiện)
    document.getElementById('mic-permission-card').classList.add('hidden');
    return true; // Trả về true để cho phép chạy bước tiếp theo (gửi tin nhắn cho Offscreen)

  } catch (error) {
    console.error("Chi tiết lỗi quyền Micro:", error);
    
    // Nếu lỗi là NotAllowedError (Người dùng bấm Block hoặc Hệ thống chặn)
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      // Hiển thị thẻ cảnh báo lỗi màu vàng trong popup.html của bạn
      const warningCard = document.getElementById('mic-permission-card');
      warningCard.classList.remove('hidden');
      
      // Sửa text hướng dẫn cụ thể thay vì bảo "click address bar"
      document.getElementById('mic-permission-desc').innerText = 
        "Chrome đã chặn quyền Micro. Vui lòng bấm nút bên dưới để mở cài đặt và chọn Allow (Cho phép).";
      
      // Cập nhật hành động cho nút bấm để mở trang cài đặt Extension
      document.getElementById('btn-grant-mic').onclick = () => {
        chrome.tabs.create({ url: 'chrome://settings/content/siteDetails?site=chrome-extension://' + chrome.runtime.id });
      };
    }
    
    return false; // Trả về false để chặn luồng, không gọi Offscreen nữa
  }
}

// CÁCH SỬ DỤNG KHI BẤM NÚT START RECORDING:
// document.getElementById('start-btn').addEventListener('click', async () => {
//    const isPermitted = await checkAndRequestMicrophonePermission();
//    if (isPermitted) {
//        // Bắt đầu gửi tin nhắn START_RECORDING cho Background -> Offscreen
//        chrome.runtime.sendMessage({ action: "START_RECORDING" });
//    }
// });

