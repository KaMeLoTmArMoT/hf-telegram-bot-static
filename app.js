// Initialize Telegram WebApp
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

// URL parameters
const urlParams = new URLSearchParams(window.location.search);

// Determine API Base URL (reads from window.API_BASE_URL, query param api_url, or defaults to relative same-origin path)
const API_BASE_URL = (window.API_BASE_URL || urlParams.get('api_url') || '').replace(/\/+$/, '');

// Display Version Tag
const versionEl = document.getElementById('app-version-tag');
if (versionEl && window.APP_VERSION) {
    versionEl.textContent = `${window.APP_VERSION}`;
}

// UI Elements
const screenRecorder = document.getElementById('recorder-screen');
const screenProcessing = document.getElementById('processing-screen');
const screenResult = document.getElementById('result-screen');

const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const quotaBadge = document.getElementById('quota-badge');
const quotaText = document.getElementById('quota-text');
const timerDisplay = document.getElementById('timer-display');
const canvas = document.getElementById('waveform-canvas');
const canvasCtx = canvas.getContext('2d');

const recordCore = document.getElementById('record-core');
const btnRecord = document.getElementById('btn-record');
const btnStop = document.getElementById('btn-stop');
const iconPause = document.getElementById('icon-pause');
const iconPlay = document.getElementById('icon-play');

const btnBack = document.getElementById('btn-back');
const btnCopy = document.getElementById('btn-copy');
const transcriptBox = document.getElementById('transcript-box');

const btnSummary = document.getElementById('btn-summary');
const btnCustomQ = document.getElementById('btn-custom-q');
const aiCard = document.getElementById('ai-response-card');
const aiCardTitle = document.getElementById('ai-card-title');
const aiCardBody = document.getElementById('ai-card-body');
const btnCloseAi = document.getElementById('btn-close-ai');

const questionModal = document.getElementById('question-modal');
const inputCustomQuestion = document.getElementById('input-custom-question');
const btnCancelQ = document.getElementById('btn-cancel-q');
const btnSendQ = document.getElementById('btn-send-q');

// Recording State
let mediaRecorder = null;
let audioChunks = [];
let recordingInterval = null;
let startTime = 0;
let elapsedTime = 0;
let isPaused = false;
let wakeLock = null;

// Audio Context & Visualizer State
let audioCtx = null;
let analyser = null;
let dataArray = null;
let animationFrameId = null;
let activeStream = null;
let smoothedHeights = [];
const NUM_VISUALIZER_BARS = 32;

// Current Transcript State
let currentTranscript = '';

// Task Queue State
let trackedJobs = [];
let pollingIntervalId = null;
let recordingCounter = 0;

// AI & Audio Quota State
let aiQuotaState = { isAllowed: true, remaining: null, tier: null };

function updateQuotaUI(quota) {
    if (!quota) return;
    aiQuotaState.isAllowed = quota.is_allowed !== false && quota.remaining_today !== 0;
    aiQuotaState.remaining = quota.remaining_today;
    aiQuotaState.tier = quota.tier;

    if (quotaText) {
        if (quota.remaining_today === null || quota.remaining_today === undefined) {
            quotaText.innerText = '⚡ ∞';
            quotaBadge?.classList.remove('locked');
            if (quotaBadge) quotaBadge.title = 'Необмежений доступ (Admin / Unlimited)';
        } else if (quota.remaining_today <= 0) {
            quotaText.innerText = '🔒 0';
            quotaBadge?.classList.add('locked');
            if (quotaBadge) quotaBadge.title = '🔒 Денний ліміт вичерпано (відновиться о 00:00 UTC)';
        } else {
            quotaText.innerText = `⚡ ${quota.remaining_today}`;
            quotaBadge?.classList.remove('locked');
            if (quotaBadge) quotaBadge.title = `Доступно кредитів: ${quota.remaining_today} (1 хв = 1 кредит)`;
        }
    }

    const isLocked = aiQuotaState.remaining === 0 || aiQuotaState.isAllowed === false;
    if (isLocked) {
        btnSummary?.classList.add('locked');
        btnCustomQ?.classList.add('locked');
    } else {
        btnSummary?.classList.remove('locked');
        btnCustomQ?.classList.remove('locked');
    }
}

async function fetchUserQuota() {
    const { userId, initData } = getTelegramUserContext();
    const params = new URLSearchParams();
    if (userId) params.append('user_id', userId);
    if (initData) params.append('init_data', initData);

    try {
        const res = await fetch(`${API_BASE_URL}/api/tma/quota?${params.toString()}`);
        if (res.ok) {
            const data = await res.json();
            if (data?.ai_quota) {
                updateQuotaUI(data.ai_quota);
            }
        }
    } catch (err) {
        console.warn('Could not fetch user quota:', err);
    }
}

function showQuotaExhaustedAlert(feature = "ШІ та транскрибації") {
    if (tg?.HapticFeedback) {
        tg.HapticFeedback.notificationOccurred('warning');
    }
    const msg =
        `🔒 Денний ліміт ${feature} вичерпано.\n\n` +
        "Ліміт автоматично оновлюється щодня о 00:00 UTC ⏳\n\n" +
        "💡 Маєте ваучер поповнення? Активуйте його в чаті бота (/start rst_...) або зверніться до адміністратора.";
    if (tg?.showAlert) {
        tg.showAlert(msg);
    } else {
        alert(msg);
    }
}

// Screen Navigation
function showScreen(screen) {
    [screenRecorder, screenProcessing, screenResult].forEach(s => s?.classList.remove('active'));
    screen?.classList.add('active');
}

// Screen Wake Lock
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (err) {
        console.warn('Wake Lock request failed:', err);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}

// Timer
function startTimer() {
    startTime = Date.now() - elapsedTime;
    recordingInterval = setInterval(() => {
        elapsedTime = Date.now() - startTime;
        updateTimerDisplay(elapsedTime);
    }, 1000);
}

function stopTimer() {
    if (recordingInterval) {
        clearInterval(recordingInterval);
        recordingInterval = null;
    }
}

function resetTimer() {
    stopTimer();
    elapsedTime = 0;
    if (timerDisplay) timerDisplay.innerText = '00:00';
}

function updateTimerDisplay(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    if (timerDisplay) {
        timerDisplay.innerText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
}

// Audio Visualizer
async function setupAudioVisualizer(stream) {
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        analyser = audioCtx.createAnalyser();
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);

        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.8;
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);

        smoothedHeights = new Array(NUM_VISUALIZER_BARS).fill(6);
        resizeCanvas();
    } catch (err) {
        console.warn('Audio visualizer setup error:', err);
    }
}

function stopAudioVisualizer() {
    analyser = null;
    dataArray = null;
}

function resizeCanvas() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
    }
}

function drawWaveform() {
    animationFrameId = requestAnimationFrame(drawWaveform);
    if (!canvas || !canvasCtx) return;

    const width = canvas.width;
    const height = canvas.height;
    if (width === 0 || height === 0) return;

    canvasCtx.clearRect(0, 0, width, height);

    const isRecording = mediaRecorder && mediaRecorder.state === 'recording';
    const numBars = NUM_VISUALIZER_BARS;
    const totalGapRatio = 0.35;
    const barWidth = (width / numBars) * (1 - totalGapRatio);
    const gap = (width / numBars) * totalGapRatio;

    if (isRecording && analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);
    }

    const time = Date.now() * 0.003;

    for (let i = 0; i < numBars; i++) {
        let targetH = 6;
        if (isRecording && dataArray) {
            const sampleIdx = Math.floor((i / numBars) * Math.min(dataArray.length, 48));
            const val = dataArray[sampleIdx] || 0;
            targetH = Math.max(6, (val / 255) * (height * 0.85));
        } else if (isPaused) {
            targetH = 6;
        } else {
            // Ambient idle wave animation so container is never empty square
            const sine = Math.sin(time + i * 0.25);
            const cosine = Math.cos(time * 0.7 + i * 0.15);
            targetH = 8 + (sine + cosine) * 3;
        }

        if (!smoothedHeights[i]) smoothedHeights[i] = 6;
        smoothedHeights[i] = smoothedHeights[i] * 0.65 + targetH * 0.35;
        const currentH = smoothedHeights[i];

        const x = i * (barWidth + gap) + gap / 2;
        const y = (height - currentH) / 2;
        const radius = Math.min(barWidth / 2, currentH / 2);

        const gradient = canvasCtx.createLinearGradient(0, y, 0, y + currentH);
        if (isRecording) {
            gradient.addColorStop(0, '#60a5fa');
            gradient.addColorStop(0.5, '#3b82f6');
            gradient.addColorStop(1, '#8b5cf6');
        } else if (isPaused) {
            gradient.addColorStop(0, '#fbbf24');
            gradient.addColorStop(1, '#f59e0b');
        } else {
            // Soft ambient wave colors when waiting/idle
            gradient.addColorStop(0, 'rgba(96, 165, 250, 0.45)');
            gradient.addColorStop(1, 'rgba(139, 92, 246, 0.25)');
        }

        canvasCtx.fillStyle = gradient;
        canvasCtx.beginPath();
        if (canvasCtx.roundRect) {
            canvasCtx.roundRect(x, y, barWidth, currentH, radius);
        } else {
            canvasCtx.rect(x, y, barWidth, currentH);
        }
        canvasCtx.fill();
    }
}

// Audio Stream Acquisition with Multi-Level Progressive Hardware Fallback
async function getAudioStream() {
    if (activeStream && activeStream.active && activeStream.getAudioTracks().some(t => t.readyState === 'live')) {
        return activeStream;
    }

    const constraintTiers = [
        // Tier 1: Optimal studio/voice memo recording without destructive VoIP/telephony filtering
        // Disabling echoCancellation & noiseSuppression prevents Bluetooth/iOS/Android from forcing
        // narrow-band 8kHz/16kHz SCO (telephone call) mode and preserves full acoustic dynamic range.
        {
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: { ideal: 1 },
                sampleRate: { ideal: 48000 }
            }
        },
        // Tier 2: Soft constraints allowing device to prioritize clean 48kHz mono
        {
            audio: {
                echoCancellation: { ideal: false },
                noiseSuppression: { ideal: false },
                autoGainControl: { ideal: false },
                channelCount: { ideal: 1 },
                sampleRate: { ideal: 48000 }
            }
        },
        // Tier 3: Standard clean audio fallback
        {
            audio: {
                channelCount: 1,
                sampleRate: 48000
            }
        },
        // Tier 4: Basic Hardware Audio Default Fallback
        { audio: true }
    ];

    for (const constraints of constraintTiers) {
        try {
            activeStream = await navigator.mediaDevices.getUserMedia(constraints);
            return activeStream;
        } catch (err) {
            console.warn('Microphone constraint tier unavailable, trying fallback:', err);
        }
    }

    throw new Error('Unable to access microphone on this device.');
}

function releaseAudioStream() {
    if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
        activeStream = null;
    }
}

window.addEventListener('beforeunload', releaseAudioStream);

// Helper to create MediaRecorder with adaptive bitrate fallback for mobile compatibility
function createMediaRecorder(stream) {
    const candidateMimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
        'audio/aac',
        ''
    ];

    let supportedMime = candidateMimeTypes.find(type => !type || (window.MediaRecorder && MediaRecorder.isTypeSupported(type))) || '';

    // Bitrate & option candidate tiers: prioritize high-quality speech 128k/96k/64k
    const optionTiers = [];
    if (supportedMime) {
        optionTiers.push({ mimeType: supportedMime, audioBitsPerSecond: 128000 });
        optionTiers.push({ mimeType: supportedMime, audioBitsPerSecond: 96000 });
        optionTiers.push({ mimeType: supportedMime, audioBitsPerSecond: 64000 });
        optionTiers.push({ mimeType: supportedMime });
    }
    optionTiers.push({}); // Browser native default fallback

    for (const opts of optionTiers) {
        try {
            return new MediaRecorder(stream, opts);
        } catch (err) {
            console.warn('MediaRecorder option tier unavailable, trying fallback:', err);
        }
    }

    return new MediaRecorder(stream);
}

// Start Recording
async function startRecording() {
    try {
        const stream = await getAudioStream();

        mediaRecorder = createMediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            // Keep persistentStream active to avoid re-requesting mic permission on next record!
            stopAudioVisualizer();
            releaseWakeLock();
        };

        mediaRecorder.start(1000);
        await requestWakeLock();
        await setupAudioVisualizer(stream);

        isPaused = false;
        startTimer();

        // UI Updates
        btnRecord.classList.add('recording');
        if (recordCore) recordCore.classList.add('hidden');
        iconPause.classList.remove('hidden');
        iconPlay.classList.add('hidden');
        btnStop.classList.remove('hidden');

        statusBadge.className = 'status-badge recording';
        statusText.innerText = 'Recording...';

    } catch (err) {
        alert('Failed to access microphone: ' + err.message);
    }
}

// Pause / Resume Recording
function togglePause() {
    if (!mediaRecorder) return;

    if (!isPaused) {
        mediaRecorder.pause();
        stopTimer();
        isPaused = true;

        iconPause.classList.add('hidden');
        iconPlay.classList.remove('hidden');

        statusBadge.className = 'status-badge paused';
        statusText.innerText = 'Paused';
    } else {
        mediaRecorder.resume();
        startTimer();
        isPaused = false;

        iconPause.classList.remove('hidden');
        iconPlay.classList.add('hidden');

        statusBadge.className = 'status-badge recording';
        statusText.innerText = 'Recording...';
    }
}

// Toast Feedback Notification Helper
let toastTimeout = null;
function showToast(text, icon = '🚀') {
    const toast = document.getElementById('toast-notification');
    const toastText = document.getElementById('toast-text');
    const toastIcon = document.getElementById('toast-icon');
    if (!toast || !toastText) return;

    if (toastTimeout) {
        clearTimeout(toastTimeout);
        toastTimeout = null;
    }

    if (toastIcon) toastIcon.innerText = icon;
    toastText.innerText = text;
    toast.classList.remove('hidden', 'fade-out');

    toastTimeout = setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => {
            toast.classList.add('hidden');
            toast.classList.remove('fade-out');
        }, 350);
    }, 2800);
}

// Job Queue & Pipeline Tracker UI
const STAGE_STEP_MS = 500; // Artificial minimum time per pipeline step for smooth animation
const STAGE_LABELS = {
    1: '📦 Preparing audio...',
    2: '🎙️ Transcribing with Groq STT...',
    3: '🧠 Identifying speakers...',
    4: '✅ Finalizing...'
};
const STAGE_PROGRESS = { 1: 25, 2: 50, 3: 75, 4: 100 };

function getServerStageIdx(job) {
    if (job.status === 'completed' || job.status === 'duplicating') return 4;
    if (job.status === 'diarizing_llm') return 3;
    if (job.status === 'transcribing_groq') return 2;
    return 1;
}

// Advances job.visualStage one step at a time (STAGE_STEP_MS apart) toward the
// server-reported stage, so fast pipelines animate smoothly instead of jumping.
function ensureStageAnimation(job) {
    if (job.status === 'failed') {
        if (job.stageTimer) {
            clearTimeout(job.stageTimer);
            job.stageTimer = null;
        }
        return;
    }
    const serverIdx = getServerStageIdx(job);
    if (job.visualStage === undefined) {
        job.visualStage = Math.min(1, serverIdx);
    }
    if (job.stageTimer || job.visualStage >= serverIdx) return;
    job.stageTimer = setTimeout(() => {
        job.stageTimer = null;
        if (job.visualStage < getServerStageIdx(job)) {
            job.visualStage += 1;
            renderJobQueue();
        }
    }, STAGE_STEP_MS);
}

function renderJobQueue() {
    const jobsContainer = document.getElementById('jobs-container');
    const jobsList = document.getElementById('jobs-list');
    const jobsCountBadge = document.getElementById('jobs-count-badge');

    if (!jobsContainer || !jobsList || !jobsCountBadge) return;

    if (trackedJobs.length === 0) {
        jobsContainer.classList.add('hidden');
        return;
    }

    jobsContainer.classList.remove('hidden');
    const activeCount = trackedJobs.filter(j => j.status !== 'completed' && j.status !== 'failed').length;
    jobsCountBadge.innerText = activeCount > 0 ? `${activeCount} processing` : `${trackedJobs.length} total`;

    jobsList.innerHTML = '';

    // Render jobs in reverse order (newest first)
    [...trackedJobs].reverse().forEach((job) => {
        const card = document.createElement('div');
        const isCompleted = job.status === 'completed';
        const isFailed = job.status === 'failed';
        const isUploading = job.status === 'uploading';
        ensureStageAnimation(job);

        const serverStageIdx = getServerStageIdx(job);
        const currentStageIdx = job.visualStage === undefined ? serverStageIdx : job.visualStage;
        const visuallyComplete = isCompleted && currentStageIdx >= 4;
        card.className = `job-card ${visuallyComplete ? 'completed' : isFailed ? 'failed' : 'active-job'}`;

        const displayProgress = currentStageIdx < serverStageIdx
            ? STAGE_PROGRESS[currentStageIdx]
            : Math.min(job.progress || STAGE_PROGRESS[serverStageIdx], 100);
        const displayLabel = currentStageIdx < serverStageIdx
            ? STAGE_LABELS[currentStageIdx]
            : (job.stage_label || 'Processing...');

        const stepsHtml = `
            <div class="pipeline-steps">
                <span class="pipeline-step ${currentStageIdx > 1 ? 'done' : currentStageIdx === 1 ? 'active' : ''}">📦 Prep</span>
                <span class="pipeline-step ${currentStageIdx > 2 ? 'done' : currentStageIdx === 2 ? 'active' : ''}">🎙️ Groq STT</span>
                <span class="pipeline-step ${currentStageIdx > 3 ? 'done' : currentStageIdx === 3 ? 'active' : ''}">🧠 Diarize</span>
                <span class="pipeline-step ${currentStageIdx >= 4 ? (isFailed ? 'failed' : 'done') : ''}">✅ Done</span>
            </div>
        `;

        card.innerHTML = `
            <div class="job-top-row">
                <span class="job-title">🎙️ ${job.recordingName || 'Audio Recording'}</span>
                <span class="job-status-pill">${visuallyComplete ? '✓ Ready' : isFailed ? '✕ Error' : isUploading ? '🚀 Uploading' : displayProgress + '%'}</span>
            </div>
            <div class="job-stage-desc">${displayLabel}</div>
            ${!visuallyComplete && !isFailed ? `
                <div class="job-progress-bg">
                    <div class="job-progress-fill" style="width: ${displayProgress}%"></div>
                </div>
            ` : ''}
            ${stepsHtml}
            ${visuallyComplete ? '<div class="job-view-btn">📄 Open Transcript →</div>' : ''}
        `;

        card.addEventListener('click', () => {
            if (isCompleted && job.result) {
                currentTranscript = job.result.formatted_text || job.result.raw_text || '';
                transcriptBox.innerText = currentTranscript;
                showScreen(screenResult);
            } else if (isFailed) {
                alert(`Job error: ${job.error || 'Processing failed'}`);
            } else {
                showToast('⏳ AI is transcribing audio in background...', '⚡');
            }
        });

        jobsList.appendChild(card);
    });
}

function startPollingTasks() {
    if (pollingIntervalId) return;
    pollingIntervalId = setInterval(pollTaskStatuses, 1500);
}

function stopPollingTasks() {
    if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
        pollingIntervalId = null;
    }
}

async function pollTaskStatuses() {
    const activeJobs = trackedJobs.filter(j => j.status !== 'completed' && j.status !== 'failed');
    if (activeJobs.length === 0) {
        stopPollingTasks();
        return;
    }

    const { userId, initData } = getTelegramUserContext();
    const params = new URLSearchParams();
    if (userId) params.append('user_id', userId);
    if (initData) params.append('init_data', initData);
    const queryString = params.toString() ? `?${params.toString()}` : '';

    for (const job of activeJobs) {
        if (!job.task_id || job.task_id.startsWith('temp_')) continue;
        try {
            const res = await fetch(`${API_BASE_URL}/api/tma/tasks/${job.task_id}${queryString}`);
            if (res.ok) {
                const data = await res.json();
                const wasCompleted = job.status === 'completed';
                job.status = data.status;
                job.stage_label = data.stage_label;
                job.progress = data.progress;
                job.result = data.result;
                job.error = data.error;

                if (!wasCompleted && data.status === 'completed') {
                    if (tg?.HapticFeedback) {
                        tg.HapticFeedback.notificationOccurred('success');
                    }
                    showToast(`✅ ${job.recordingName || 'Recording'} transcript ready!`, '⚡');
                }
            }
        } catch (err) {
            console.warn('Task status poll error:', err);
        }
    }

    renderJobQueue();
}

// Stop Recording with instant visual feedback and optimistic task queue entry
async function stopRecording() {
    if (!mediaRecorder) return;

    recordingCounter += 1;
    const recName = `Rec #${recordingCounter}`;

    // 1. Trigger tactile haptic feedback
    if (tg?.HapticFeedback) {
        tg.HapticFeedback.impactOccurred('medium');
    }

    // 2. Animate visualizer container dispatch pulse
    const visContainer = document.querySelector('.visualizer-container');
    if (visContainer) {
        visContainer.classList.add('dispatching');
        setTimeout(() => visContainer.classList.remove('dispatching'), 600);
    }

    // 3. Update status badge to uploading state
    statusBadge.className = 'status-badge uploading';
    statusText.innerText = '🚀 Uploading audio...';
    setTimeout(() => {
        if (statusBadge.classList.contains('uploading')) {
            statusBadge.className = 'status-badge';
            statusText.innerText = 'Ready to record';
        }
    }, 2000);

    // 4. Show instant toast notification
    showToast('🎙️ Audio sent to processing queue', '🚀');

    stopTimer();
    mediaRecorder.stop();

    btnRecord.classList.remove('recording');
    if (recordCore) recordCore.classList.remove('hidden');
    iconPause.classList.add('hidden');
    iconPlay.classList.add('hidden');
    btnStop.classList.add('hidden');

    resetTimer();
    showScreen(screenRecorder); // Stay on recorder screen so user can record again immediately!

    // 5. Create optimistic pending job entry immediately
    const tempId = 'temp_' + Date.now();
    const optimisticJob = {
        task_id: tempId,
        recordingName: recName,
        status: 'uploading',
        stage_label: 'Uploading audio to server...',
        progress: 15,
        result: null,
        error: null
    };
    trackedJobs.push(optimisticJob);
    renderJobQueue();

    // 6. Collect audio blob and upload
    setTimeout(async () => {
        const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        await uploadAndTranscribeAsync(audioBlob, recName, optimisticJob);
    }, 150);
}

// Helper to extract Telegram WebApp User Context
function getTelegramUserContext() {
    const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    const devUser = urlParams.get('dev_user_id') || urlParams.get('user_id');
    const userId = tgUser || devUser || '';
    const initData = window.Telegram?.WebApp?.initData || '';
    return { userId, initData };
}

// API Calls
async function uploadAndTranscribeAsync(blob, recordingName, existingJob = null) {
    const { userId, initData } = getTelegramUserContext();
    const formData = new FormData();
    formData.append('file', blob, 'recording.webm');
    if (userId) formData.append('user_id', userId);
    if (initData) formData.append('init_data', initData);

    try {
        const res = await fetch(`${API_BASE_URL}/api/tma/transcribe-async`, {
            method: 'POST',
            body: formData
        });

        const data = await res.json().catch(() => null);

        if (!res.ok) {
            if (res.status === 429) {
                updateQuotaUI({ is_allowed: false, remaining_today: 0 });
                if (tg?.HapticFeedback) {
                    tg.HapticFeedback.notificationOccurred('error');
                }
            }
            throw new Error(data?.detail || `Server error (${res.status})`);
        }

        // Refresh quota after successful upload
        fetchUserQuota();

        if (!data || !data.task_id) {
            throw new Error("Invalid response from async transcribe API.");
        }

        if (existingJob) {
            existingJob.task_id = data.task_id;
            existingJob.status = data.status || 'queued';
            existingJob.stage_label = data.stage_label || 'Queued for processing...';
            existingJob.progress = data.progress || 20;
        } else {
            const newJob = {
                task_id: data.task_id,
                recordingName: recordingName,
                status: data.status || 'queued',
                stage_label: data.stage_label || 'Queued for processing...',
                progress: data.progress || 20,
                result: null,
                error: null
            };
            trackedJobs.push(newJob);
        }

        renderJobQueue();
        startPollingTasks();

    } catch (err) {
        console.error('Async upload failed:', err);
        if (existingJob) {
            existingJob.status = 'failed';
            existingJob.stage_label = 'Upload failed';
            existingJob.progress = 100;
            existingJob.error = err.message;
        } else {
            trackedJobs.push({
                task_id: 'err_' + Date.now(),
                recordingName: recordingName,
                status: 'failed',
                stage_label: 'Upload failed',
                progress: 100,
                error: err.message
            });
        }
        renderJobQueue();
    }
}

async function uploadAndTranscribe(blob) {
    return uploadAndTranscribeAsync(blob, 'Recording');
}


async function requestSummary() {
    if (!currentTranscript) return;

    if (aiQuotaState.remaining === 0 || aiQuotaState.isAllowed === false) {
        showQuotaExhaustedAlert("генерації Summary");
        return;
    }

    aiCard.classList.remove('hidden');
    aiCardTitle.innerText = '📝 Summary';
    aiCardBody.innerText = 'Generating summary...';

    const { userId, initData } = getTelegramUserContext();
    const payload = { text: currentTranscript };
    if (userId) payload.user_id = userId;
    if (initData) payload.init_data = initData;

    try {
        const res = await fetch(`${API_BASE_URL}/api/tma/summary`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => null);

        if (!res.ok) {
            if (res.status === 429) {
                updateQuotaUI({ is_allowed: false, remaining_today: 0 });
                if (tg?.HapticFeedback) {
                    tg.HapticFeedback.notificationOccurred('error');
                }
            }
            throw new Error(data?.detail || `Server error (${res.status})`);
        }

        aiCardBody.innerText = data?.summary || "No summary returned.";
        fetchUserQuota();
    } catch (err) {
        aiCardBody.innerText = err.message;
    }
}

async function sendCustomQuestion() {
    const q = inputCustomQuestion.value.trim();
    if (!q || !currentTranscript) return;

    if (aiQuotaState.remaining === 0 || aiQuotaState.isAllowed === false) {
        showQuotaExhaustedAlert("відповідей на питання");
        return;
    }

    questionModal.classList.add('hidden');
    aiCard.classList.remove('hidden');
    aiCardTitle.innerText = `❓ Question: "${q}"`;
    aiCardBody.innerText = 'Thinking...';

    const { userId, initData } = getTelegramUserContext();
    const payload = { text: currentTranscript, question: q };
    if (userId) payload.user_id = userId;
    if (initData) payload.init_data = initData;

    try {
        const res = await fetch(`${API_BASE_URL}/api/tma/custom-question`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => null);

        if (!res.ok) {
            if (res.status === 429) {
                updateQuotaUI({ is_allowed: false, remaining_today: 0 });
                if (tg?.HapticFeedback) {
                    tg.HapticFeedback.notificationOccurred('error');
                }
            }
            throw new Error(data?.detail || `Server error (${res.status})`);
        }

        aiCardBody.innerText = data?.answer || "No answer returned.";
        inputCustomQuestion.value = '';
        fetchUserQuota();
    } catch (err) {
        aiCardBody.innerText = err.message;
    }
}

// Event Listeners
btnRecord.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        togglePause();
        return;
    }

    if (aiQuotaState.remaining === 0 || aiQuotaState.isAllowed === false) {
        showQuotaExhaustedAlert("запису та транскрибації");
        return;
    }

    resetTimer();
    startRecording();
});

btnStop.addEventListener('click', stopRecording);

btnBack.addEventListener('click', () => {
    resetTimer();
    statusBadge.className = 'status-badge';
    statusText.innerText = 'Ready to record';
    aiCard.classList.add('hidden');
    questionModal.classList.add('hidden');
    showScreen(screenRecorder);
});

btnCopy.addEventListener('click', () => {
    if (currentTranscript) {
        navigator.clipboard.writeText(currentTranscript);
        if (tg?.HapticFeedback) {
            tg.HapticFeedback.notificationOccurred('success');
        }
        btnCopy.innerText = 'Copied!';
        setTimeout(() => { btnCopy.innerText = 'Copy'; }, 2000);
    }
});

btnSummary.addEventListener('click', requestSummary);

btnCustomQ.addEventListener('click', () => {
    if (aiQuotaState.remaining === 0 || aiQuotaState.isAllowed === false) {
        showQuotaExhaustedAlert("відповідей на питання");
        return;
    }
    questionModal.classList.remove('hidden');
    inputCustomQuestion.focus();
});

btnCancelQ.addEventListener('click', () => {
    questionModal.classList.add('hidden');
});

btnSendQ.addEventListener('click', sendCustomQuestion);

btnCloseAi.addEventListener('click', () => {
    aiCard.classList.add('hidden');
});

if (quotaBadge) {
    quotaBadge.addEventListener('click', async () => {
        if (tg?.HapticFeedback) {
            tg.HapticFeedback.impactOccurred('light');
        }
        await fetchUserQuota();
        const rem = aiQuotaState.remaining;
        const msg = (rem === null || rem === undefined)
            ? "⚡ У вас необмежений доступ (Admin / Unlimited)!"
            : rem <= 0
            ? "🔒 Денний ліміт вичерпано. Оновиться о 00:00 UTC або за ваучером /start rst_..."
            : `⚡ Залишилось кредитів на сьогодні: ${rem}\n\n🎙️ 1 хв аудіо = 1 кредит\n📝 1000 символів тексту = 1 кредит`;
        if (tg?.showAlert) {
            tg.showAlert(msg);
        } else {
            alert(msg);
        }
    });
}

// Re-fetch quota on focus / visibility change
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        fetchUserQuota();
    }
});
window.addEventListener('focus', fetchUserQuota);

// Initial quota fetch
fetchUserQuota();

// Initialize visualizer loop and window resize handler
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
drawWaveform();
