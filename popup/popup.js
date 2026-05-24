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

    // Load plaintext keys directly
    if (data.geminiApiKey) {
      apiKeyInput.value = data.geminiApiKey;
    }
    if (data.deepgramApiKey) {
      deepgramKeyInput.value = data.deepgramApiKey;
    }
    
    refreshChatTabUI();
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
