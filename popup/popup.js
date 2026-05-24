/**
 * popup/popup.js
 * Controls settings saving, API key mask toggling, and broadcasts session resets.
 */

document.addEventListener('DOMContentLoaded', () => {
  const masterPasswordInput = document.getElementById('master-password');
  const lockStatusSpan = document.getElementById('lock-status');
  const toggleMasterBtn = document.getElementById('toggle-master-visibility');
  const unlockBtn = document.getElementById('btn-unlock');
  
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

  // Chat tab UI elements
  const tabBtnConfig = document.getElementById('tab-btn-config');
  const tabBtnChat = document.getElementById('tab-btn-chat');
  const configTabContent = document.getElementById('config-tab-content');
  const chatTabContent = document.getElementById('chat-tab-content');
  const chatLockedWarning = document.getElementById('chat-locked-warning');
  const chatActiveContainer = document.getElementById('chat-active-container');
  const chatHistory = document.getElementById('chat-history');
  const chatInput = document.getElementById('chat-input');
  const btnSendChat = document.getElementById('btn-send-chat');

  let isKeysLocked = false;
  let cachedEncryptedKeys = null;

  // Toggle master password visibility mask
  toggleMasterBtn.addEventListener('click', () => {
    if (masterPasswordInput.type === 'password') {
      masterPasswordInput.type = 'text';
      toggleMasterBtn.textContent = '🙈';
    } else {
      masterPasswordInput.type = 'password';
      toggleMasterBtn.textContent = '👁️';
    }
  });

  // Request microphone permission on load to ensure offscreen document capture works
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach(track => track.stop());
        console.log('Microphone permission pre-granted successfully.');
      })
      .catch((err) => {
        console.warn('Microphone permission pre-grant declined or failed:', err);
      });
  }

  // Load current configuration and state
  chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'deepgramApiKey', 'websocketUrl', 'uiLanguage', 'recordingState', 'recordingError'], (data) => {
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

    // Secure BYOK Check
    const hasGemini = !!data.geminiApiKey;
    const hasDeepgram = !!data.deepgramApiKey;

    if (hasGemini && typeof data.geminiApiKey === 'object' && data.geminiApiKey.ciphertext) {
      // 🔒 Locked by default
      isKeysLocked = true;
      cachedEncryptedKeys = {
        geminiApiKey: data.geminiApiKey,
        deepgramApiKey: (hasDeepgram && typeof data.deepgramApiKey === 'object') ? data.deepgramApiKey : null
      };

      // Check if already unlocked in this session
      if (chrome.storage.session) {
        chrome.storage.session.get(['geminiApiKey', 'deepgramApiKey'], (sessionResult) => {
          if (sessionResult && sessionResult.geminiApiKey) {
            // Already unlocked!
            isKeysLocked = false;
            apiKeyInput.value = sessionResult.geminiApiKey;
            deepgramKeyInput.value = sessionResult.deepgramApiKey || '';
            apiKeyInput.disabled = false;
            deepgramKeyInput.disabled = false;
            
            lockStatusSpan.textContent = '🔓 Unlocked (Session)';
            lockStatusSpan.style.background = '#e2fbe8';
            lockStatusSpan.style.color = '#15803d';
            unlockBtn.style.display = 'none';
          } else {
            // Truly locked
            apiKeyInput.value = '••••••••••••••••••••••••••••••••';
            deepgramKeyInput.value = hasDeepgram ? '••••••••••••••••••••••••••••••••' : '';
            apiKeyInput.disabled = true;
            deepgramKeyInput.disabled = true;

            lockStatusSpan.textContent = '🔒 Locked';
            lockStatusSpan.style.background = '#fee2e2';
            lockStatusSpan.style.color = '#991b1b';
            unlockBtn.style.display = 'inline-block';
          }
          refreshChatTabUI();
        });
      } else {
        // Fallback if session storage not supported/initialized yet
        refreshChatTabUI();
      }
    } else {
      // Plaintext or fresh installation
      isKeysLocked = false;
      if (data.geminiApiKey) {
        apiKeyInput.value = data.geminiApiKey;
      }
      if (data.deepgramApiKey) {
        deepgramKeyInput.value = data.deepgramApiKey;
      }
      
      if (hasGemini) {
        lockStatusSpan.textContent = '🔓 Plaintext (Warning)';
        lockStatusSpan.style.background = '#fef3c7';
        lockStatusSpan.style.color = '#b45309';
      } else {
        lockStatusSpan.textContent = '🔓 Unlocked';
        lockStatusSpan.style.background = '#e0f2fe';
        lockStatusSpan.style.color = '#0369a1';
      }
      unlockBtn.style.display = 'none';
      refreshChatTabUI();
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

  // Unlock button click handler
  unlockBtn.addEventListener('click', async () => {
    const password = masterPasswordInput.value;
    if (!password) {
      showToast('Error: Please enter your Master Password to unlock.', true);
      return;
    }

    if (!cachedEncryptedKeys || !cachedEncryptedKeys.geminiApiKey) {
      showToast('Error: No encrypted keys to unlock.', true);
      return;
    }

    try {
      showToast('Decrypting...');
      const decryptedGemini = await decryptText(cachedEncryptedKeys.geminiApiKey, password);
      
      let decryptedDeepgram = '';
      if (cachedEncryptedKeys.deepgramApiKey) {
        decryptedDeepgram = await decryptText(cachedEncryptedKeys.deepgramApiKey, password);
      }

      // If we got here, decryption succeeded!
      if (chrome.storage.session) {
        if (chrome.storage.session.setAccessLevel) {
          await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
        }
        await new Promise((resolve) => {
          chrome.storage.session.set({
            geminiApiKey: decryptedGemini,
            deepgramApiKey: decryptedDeepgram
          }, resolve);
        });
      }

      isKeysLocked = false;
      apiKeyInput.value = decryptedGemini;
      deepgramKeyInput.value = decryptedDeepgram;
      apiKeyInput.disabled = false;
      deepgramKeyInput.disabled = false;

      lockStatusSpan.textContent = '🔓 Unlocked';
      lockStatusSpan.style.background = '#e2fbe8';
      lockStatusSpan.style.color = '#15803d';
      unlockBtn.style.display = 'none';

      refreshChatTabUI();
      showToast('Keys unlocked successfully!');
    } catch (err) {
      console.error('Decryption failed:', err);
      showToast('Error: Invalid Master Password.', true);
    }
  });

  // Save Settings handler
  saveBtn.addEventListener('click', async () => {
    const rawApiKey = apiKeyInput.value.trim();
    const rawDeepgramKey = deepgramKeyInput.value.trim();
    const rawWsUrl = wsUrlInput.value.trim();
    const masterPassword = masterPasswordInput.value;

    const selectedModel = modelSelect.value;

    // 1. Strict Validation
    if (isKeysLocked) {
      showToast('Error: Keys are locked. Unlock them with Master Password first.', true);
      return;
    }

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
      let finalGeminiKey = rawApiKey;
      let finalDeepgramKey = rawDeepgramKey;

      if (masterPassword) {
        showToast('Encrypting...');
        finalGeminiKey = await encryptText(rawApiKey, masterPassword);
        if (rawDeepgramKey) {
          finalDeepgramKey = await encryptText(rawDeepgramKey, masterPassword);
        }
      } else {
        if (cachedEncryptedKeys && cachedEncryptedKeys.geminiApiKey) {
          if (!confirm('You previously had encrypted keys. Saving without a Master Password will store your keys in plain-text. Continue?')) {
            return;
          }
        }
      }

      // 2. Persist to Chrome Local Storage
      chrome.storage.local.set({
        geminiApiKey: finalGeminiKey,
        geminiModel: selectedModel,
        deepgramApiKey: finalDeepgramKey,
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

        // Update local cached keys structure
        if (masterPassword) {
          cachedEncryptedKeys = {
            geminiApiKey: finalGeminiKey,
            deepgramApiKey: rawDeepgramKey ? finalDeepgramKey : null
          };
          lockStatusSpan.textContent = '🔓 Unlocked (Encrypted)';
          lockStatusSpan.style.background = '#e2fbe8';
          lockStatusSpan.style.color = '#15803d';
        } else {
          cachedEncryptedKeys = null;
          lockStatusSpan.textContent = '🔓 Plaintext (Warning)';
          lockStatusSpan.style.background = '#fef3c7';
          lockStatusSpan.style.color = '#b45309';
        }

        isKeysLocked = false;
        refreshChatTabUI();
        showToast('Settings saved successfully!');
        console.log('Saved configuration.');
      });
    } catch (err) {
      console.error('Encryption failed:', err);
      showToast('Error encrypting keys: ' + err.message, true);
    }
  });

  // Reset Session handler
  resetBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear current transcript data and reset meeting status?')) {
      chrome.runtime.sendMessage({ action: 'RESET_MEETING_SESSION' }, (response) => {
        if (response && response.success) {
          showToast('Session reset successfully.');
          updateStateUI('IDLE');
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
    configTabContent.classList.remove('hidden');
    chatTabContent.classList.add('hidden');
  });

  tabBtnChat.addEventListener('click', () => {
    tabBtnChat.classList.add('active');
    tabBtnConfig.classList.remove('active');
    chatTabContent.classList.remove('hidden');
    configTabContent.classList.add('hidden');
    refreshChatTabUI();
  });

  // Refresh Chat view based on keys locked/unlocked state
  function refreshChatTabUI() {
    if (isKeysLocked) {
      chatLockedWarning.classList.remove('hidden');
      chatActiveContainer.classList.add('hidden');
    } else {
      chatLockedWarning.classList.add('hidden');
      chatActiveContainer.classList.remove('hidden');
    }
  }

  // Chat message send handlers
  btnSendChat.addEventListener('click', triggerChatMessageSend);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      triggerChatMessageSend();
    }
  });

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

      // Retrieve Gemini parameters
      const apiKey = apiKeyInput.value.trim();

      // 3. Append temporary loading bubble
      const loadingBubble = appendChatBubble(uiLang === 'vi' ? 'Đang suy nghĩ...' : 'Thinking...', 'assistant');
      chatHistory.scrollTop = chatHistory.scrollHeight;

      // 4. Call geminiService.chatWithMeeting
      if (window.geminiService && typeof window.geminiService.chatWithMeeting === 'function') {
        const responseText = await window.geminiService.chatWithMeeting(apiKey, transcriptText, query, uiLang);
        loadingBubble.textContent = responseText;
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
