const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const phone = require('phone');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const CONFIG = {
    COMPANY_NAME: "IAN TECH",
    COMPANY_CONTACT: "+254723278526",
    COMPANY_EMAIL: "contact@iantech.co.ke",
    COMPANY_WEBSITE: "https://iantech.co.ke",
    SESSION_PREFIX: "IAN_TECH",
    LOGO_URL: "https://files.catbox.moe/f7f4r1.jpg",
    CODE_LENGTH: 8,
    CODE_EXPIRY_MINUTES: 10,
    DEFAULT_PHONE_EXAMPLE: "723278526",
    VERSION: "2.1.0",
    AUTHOR: "IAN TECH",
    AUTO_ACTIVATED: true,
    MAX_SESSIONS: 100,
    CLEANUP_INTERVAL: 60000,
    CONNECTION_TIMEOUT: 30000,
    MAX_QR_ATTEMPTS: 5
};

// ==================== GLOBAL STATE ====================
let activeSocket = null;
let currentQR = null;
let qrImageDataUrl = null;
let pairingCodes = new Map();
let botStatus = 'disconnected';
let lastGeneratedCode = null;
let lastGeneratedDisplayCode = null;
let autoActivationAttempts = 0;
let isConnecting = false;
let connectionStartTime = null;
let lastConnectionUpdate = null;

// ==================== UTILITY FUNCTIONS ====================
function generateAlphanumericCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    
    for (let i = 0; i < 8; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    return code;
}

function formatDisplayCode(code) {
    if (code.length === 8) {
        return `${code.substring(0, 4)}-${code.substring(4)}`;
    }
    return code;
}

function validateAndFormatPhoneNumber(phoneNumber) {
    try {
        let cleanNumber = phoneNumber.toString().trim();
        cleanNumber = cleanNumber.replace(/[^\d+]/g, '');
        
        if (cleanNumber.startsWith('0') && cleanNumber.length >= 9) {
            cleanNumber = '+254' + cleanNumber.substring(1);
        } else if (!cleanNumber.startsWith('+') && cleanNumber.length >= 9) {
            cleanNumber = '+' + cleanNumber;
        }
        
        const parsed = parsePhoneNumberFromString(cleanNumber);
        if (parsed && parsed.isValid()) {
            return {
                isValid: true,
                formatted: parsed.number,
                country: parsed.country || 'Unknown',
                rawNumber: cleanNumber
            };
        }
        
        const phoneResult = phone(cleanNumber);
        if (phoneResult.isValid) {
            return {
                isValid: true,
                formatted: phoneResult.phoneNumber,
                country: phoneResult.countryIso2 || 'Unknown',
                rawNumber: cleanNumber
            };
        }
        
        const digitsOnly = cleanNumber.replace(/\D/g, '');
        if (digitsOnly.length >= 9 && digitsOnly.length <= 15) {
            return {
                isValid: true,
                formatted: `+${digitsOnly}`,
                country: 'KE',
                rawNumber: cleanNumber
            };
        }
        
        return { 
            isValid: false, 
            error: 'Invalid phone number format. Use: 723278526 or +254723278526' 
        };
        
    } catch (error) {
        return { 
            isValid: false, 
            error: 'Validation error: ' + error.message 
        };
    }
}

function getStatusColor(status) {
    switch(status) {
        case 'online': return '#28a745';
        case 'qr_ready': return '#ffc107';
        case 'connecting': return '#17a2b8';
        case 'disconnected': return '#dc3545';
        default: return '#6c757d';
    }
}

function getStatusText(status) {
    switch(status) {
        case 'online': return '✅ ONLINE - Ready for Pairing';
        case 'qr_ready': return '📱 QR READY - Scan to Connect';
        case 'connecting': return '🔄 CONNECTING...';
        case 'disconnected': return '❌ DISCONNECTED - Retrying...';
        default: return '⚙️ UNKNOWN';
    }
}

// ==================== WHATSAPP BOT INITIALIZATION ====================
async function initWhatsApp() {
    if (isConnecting) return;
    
    console.log('\n' + '═'.repeat(50));
    console.log(`${CONFIG.COMPANY_NAME} WhatsApp Pairing Service v${CONFIG.VERSION}`);
    console.log('═'.repeat(50) + '\n');
    
    isConnecting = true;
    connectionStartTime = Date.now();
    botStatus = 'connecting';
    lastConnectionUpdate = new Date();
    
    try {
        const authDir = path.join(__dirname, 'auth_info');
        await fs.ensureDir(authDir);
        
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        let version;
        try {
            const versionInfo = await fetchLatestBaileysVersion();
            version = versionInfo.version;
            console.log(`📦 Using Baileys version: ${version.join('.')}`);
        } catch (error) {
            console.log('⚠️ Could not fetch latest version, using default');
            version = [6, 0, 0];
        }
        
        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            connectTimeoutMs: CONFIG.CONNECTION_TIMEOUT,
            keepAliveIntervalMs: 25000,
            emitOwnEvents: true,
            defaultQueryTimeoutMs: 0,
        });
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            lastConnectionUpdate = new Date();
            
            // Handle QR Code
            if (qr) {
                currentQR = qr;
                botStatus = 'qr_ready';
                autoActivationAttempts++;
                
                console.log(`\n⚠️ QR Code Generated (Attempt ${autoActivationAttempts}/${CONFIG.MAX_QR_ATTEMPTS})`);
                console.log('📱 Please scan the QR code using WhatsApp');
                
                try {
                    qrImageDataUrl = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: 'H',
                        margin: 2,
                        width: 300,
                        color: {
                            dark: '#000000FF',
                            light: '#FFFFFFFF'
                        }
                    });
                    
                    console.log('✅ QR Code image generated successfully');
                    
                } catch (qrError) {
                    console.error('❌ QR Code generation error:', qrError.message);
                }
                
                if (autoActivationAttempts >= CONFIG.MAX_QR_ATTEMPTS) {
                    console.log(`\n🚫 Maximum QR attempts reached (${CONFIG.MAX_QR_ATTEMPTS})`);
                    console.log('📱 Please visit the web interface to scan the QR code');
                }
            }
            
            // Handle Connection Status
            if (connection === 'open') {
                botStatus = 'online';
                isConnecting = false;
                autoActivationAttempts = 0;
                
                const connectionTime = Date.now() - connectionStartTime;
                console.log(`\n✅ ${CONFIG.COMPANY_NAME} WhatsApp Bot is ONLINE!`);
                console.log(`⚡ Connection established in ${connectionTime}ms`);
                console.log(`📱 Phone: ${sock.user?.id || 'Unknown'}`);
                console.log(`⚡ Service ready for pairing codes\n`);
            }
            
            // Handle Disconnection
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`\n⚠️ Connection closed. Status code: ${statusCode || 'unknown'}`);
                
                botStatus = 'disconnected';
                isConnecting = false;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('🔓 Logged out from WhatsApp. Cleaning session...');
                    console.log('🔄 Restarting connection in 10 seconds...');
                    setTimeout(() => initWhatsApp(), 10000);
                } else {
                    console.log('🔄 Reconnecting in 5 seconds...');
                    setTimeout(() => initWhatsApp(), 5000);
                }
            }
        });
        
        sock.ev.on('creds.update', saveCreds);
        activeSocket = sock;
        console.log('🤖 WhatsApp client initialized successfully');
        
        return sock;
        
    } catch (error) {
        console.error('❌ WhatsApp initialization failed:', error.message);
        botStatus = 'disconnected';
        isConnecting = false;
        
        console.log('🔄 Retrying connection in 10 seconds...');
        setTimeout(() => initWhatsApp(), 10000);
    }
}

// ==================== PAIRING CODE MANAGEMENT ====================
function generateNewPairingCode(phoneNumber = null, country = null) {
    const code = generateAlphanumericCode();
    const displayCode = formatDisplayCode(code);
    const expiresAt = new Date(Date.now() + CONFIG.CODE_EXPIRY_MINUTES * 60 * 1000);
    
    const codeData = {
        code: code,
        displayCode: displayCode,
        phoneNumber: phoneNumber,
        country: country,
        status: 'pending',
        createdAt: new Date(),
        expiresAt: expiresAt,
        botStatus: botStatus,
    };
    
    pairingCodes.set(code, codeData);
    lastGeneratedCode = code;
    lastGeneratedDisplayCode = displayCode;
    
    console.log(`🔤 Generated pairing code: ${displayCode}`);
    if (phoneNumber) {
        console.log(`📱 For phone: ${phoneNumber}`);
    }
    
    // Auto-cleanup when code expires
    setTimeout(() => {
        if (pairingCodes.has(code) && pairingCodes.get(code).status === 'pending') {
            pairingCodes.delete(code);
            console.log(`🗑️ Expired code removed: ${displayCode}`);
        }
    }, CONFIG.CODE_EXPIRY_MINUTES * 60 * 1000);
    
    return codeData;
}

// ==================== EXPRESS SERVER SETUP ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== HEALTH CHECKS (REQUIRED FOR REPLIT) ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'WhatsApp Pairing Service',
        version: CONFIG.VERSION,
        uptime: process.uptime(),
        botStatus: botStatus,
        pairingCodes: pairingCodes.size,
        lastCode: lastGeneratedDisplayCode,
        lastConnectionUpdate: lastConnectionUpdate
    });
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

app.get('/ready', (req, res) => {
    res.status(200).json({ 
        status: 'ready', 
        botStatus: botStatus,
        message: 'Service is ready to accept connections'
    });
});

app.get('/live', (req, res) => {
    res.status(200).json({ 
        status: 'alive', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ==================== MAIN ROUTES ====================
app.get('/', (req, res) => {
    const statusColor = getStatusColor(botStatus);
    const statusText = getStatusText(botStatus);
    const pairingCodesCount = pairingCodes.size;
    const lastCode = lastGeneratedDisplayCode || 'None';
    
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${CONFIG.COMPANY_NAME} - WhatsApp Pairing Service</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
                font-family: 'Segoe UI', 'Roboto', 'Arial', sans-serif;
            }
            
            body {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
                display: flex;
                justify-content: center;
                align-items: center;
            }
            
            .container {
                background: white;
                border-radius: 20px;
                padding: 40px;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                max-width: 800px;
                width: 100%;
                margin: 20px;
            }
            
            .header {
                text-align: center;
                margin-bottom: 30px;
            }
            
            .logo {
                width: 100px;
                height: 100px;
                border-radius: 20px;
                object-fit: cover;
                border: 4px solid #1a73e8;
                margin-bottom: 20px;
            }
            
            h1 {
                color: #1a73e8;
                font-size: 2.5rem;
                margin-bottom: 10px;
                font-weight: 700;
            }
            
            .subtitle {
                color: #666;
                font-size: 1.1rem;
                margin-bottom: 20px;
            }
            
            .status-container {
                background: #f8f9fa;
                border-radius: 15px;
                padding: 20px;
                margin-bottom: 30px;
                text-align: center;
            }
            
            .status-badge {
                display: inline-block;
                padding: 10px 25px;
                border-radius: 50px;
                font-weight: 600;
                font-size: 1.1rem;
                margin-bottom: 15px;
                background-color: ${statusColor};
                color: white;
            }
            
            .stats {
                display: flex;
                justify-content: space-around;
                margin-top: 15px;
                flex-wrap: wrap;
                gap: 15px;
            }
            
            .stat-item {
                text-align: center;
                padding: 15px;
                background: white;
                border-radius: 10px;
                box-shadow: 0 5px 15px rgba(0,0,0,0.1);
                min-width: 150px;
            }
            
            .stat-number {
                font-size: 2rem;
                font-weight: 700;
                color: #1a73e8;
                margin-bottom: 5px;
            }
            
            .stat-label {
                color: #666;
                font-size: 0.9rem;
            }
            
            .pairing-section {
                background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
                border-radius: 15px;
                padding: 30px;
                margin-bottom: 30px;
                color: white;
            }
            
            .pairing-title {
                font-size: 1.5rem;
                margin-bottom: 20px;
                text-align: center;
            }
            
            .phone-input-container {
                background: rgba(255, 255, 255, 0.1);
                border-radius: 10px;
                padding: 20px;
                margin-bottom: 20px;
            }
            
            input[type="tel"] {
                width: 100%;
                padding: 15px 20px;
                border: none;
                border-radius: 8px;
                font-size: 1rem;
                margin-bottom: 15px;
            }
            
            .example {
                font-size: 0.9rem;
                opacity: 0.8;
                margin-top: 10px;
            }
            
            .buttons {
                display: flex;
                gap: 15px;
                justify-content: center;
                flex-wrap: wrap;
            }
            
            .btn {
                padding: 15px 30px;
                border: none;
                border-radius: 50px;
                font-size: 1rem;
                font-weight: 600;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                transition: all 0.3s ease;
                min-width: 200px;
            }
            
            .btn-primary {
                background: #1a73e8;
                color: white;
            }
            
            .btn-secondary {
                background: #ffc107;
                color: #333;
            }
            
            .btn-success {
                background: #28a745;
                color: white;
            }
            
            .btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 10px 20px rgba(0,0,0,0.2);
            }
            
            .qr-section {
                background: white;
                border-radius: 15px;
                padding: 30px;
                margin-bottom: 30px;
                text-align: center;
                border: 2px solid #1a73e8;
                display: none;
            }
            
            .qr-title {
                color: #1a73e8;
                font-size: 1.5rem;
                margin-bottom: 20px;
            }
            
            #qrImage {
                max-width: 300px;
                width: 100%;
                height: auto;
                border-radius: 10px;
                border: 2px solid #eee;
                margin: 0 auto 20px;
            }
            
            .code-display-section {
                background: #f8f9fa;
                border-radius: 15px;
                padding: 30px;
                margin-bottom: 30px;
                text-align: center;
                display: none;
            }
            
            .code-display {
                font-size: 3.5rem;
                font-weight: 800;
                letter-spacing: 5px;
                color: #1a73e8;
                margin: 20px 0;
                font-family: 'Courier New', monospace;
                background: white;
                padding: 20px;
                border-radius: 10px;
                border: 3px dashed #1a73e8;
            }
            
            .code-info {
                color: #666;
                margin-top: 15px;
            }
            
            .instructions {
                background: #f8f9fa;
                border-radius: 15px;
                padding: 25px;
                margin-top: 30px;
            }
            
            .instructions h3 {
                color: #1a73e8;
                margin-bottom: 15px;
            }
            
            .instructions ol {
                padding-left: 20px;
                margin-bottom: 15px;
            }
            
            .instructions li {
                margin-bottom: 10px;
                color: #555;
            }
            
            .footer {
                text-align: center;
                margin-top: 30px;
                color: #666;
                font-size: 0.9rem;
                border-top: 1px solid #eee;
                padding-top: 20px;
            }
            
            .notification {
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 15px 25px;
                border-radius: 10px;
                color: white;
                font-weight: 600;
                display: none;
                z-index: 1000;
                animation: slideIn 0.3s ease;
            }
            
            @keyframes slideIn {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
            
            @media (max-width: 768px) {
                .container {
                    padding: 20px;
                }
                
                h1 {
                    font-size: 2rem;
                }
                
                .btn {
                    min-width: 100%;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <img src="${CONFIG.LOGO_URL}" alt="${CONFIG.COMPANY_NAME} Logo" class="logo">
                <h1>${CONFIG.COMPANY_NAME}</h1>
                <p class="subtitle">WhatsApp Pairing Code Generator v${CONFIG.VERSION}</p>
            </div>
            
            <div class="status-container">
                <div class="status-badge" id="statusBadge">${statusText}</div>
                <div class="stats">
                    <div class="stat-item">
                        <div class="stat-number" id="pairingCount">${pairingCodesCount}</div>
                        <div class="stat-label">Active Codes</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number" id="lastCode">${lastCode}</div>
                        <div class="stat-label">Last Code</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number" id="qrAttempts">${autoActivationAttempts}</div>
                        <div class="stat-label">QR Attempts</div>
                    </div>
                </div>
            </div>
            
            <div class="pairing-section">
                <h2 class="pairing-title">Generate WhatsApp Pairing Code</h2>
                <div class="phone-input-container">
                    <input type="tel" id="phoneNumber" placeholder="Enter phone number (e.g., 723278526)" value="723278526">
                    <p class="example">Example: 723278526 (Kenya), 9876543210 (India), 1234567890 (USA)</p>
                </div>
                <div class="buttons">
                    <button class="btn btn-primary" onclick="generatePairingCode()">
                        <span>🔢</span> Generate Pairing Code
                    </button>
                    <button class="btn btn-secondary" onclick="showQRCode()">
                        <span>📱</span> Show QR Code
                    </button>
                    <button class="btn btn-success" onclick="copyToClipboard()">
                        <span>📋</span> Copy Code
                    </button>
                </div>
            </div>
            
            <div class="qr-section" id="qrSection">
                <h3 class="qr-title">Scan QR Code</h3>
                <img id="qrImage" alt="WhatsApp QR Code">
                <p>Open WhatsApp → Linked Devices → Scan QR Code</p>
            </div>
            
            <div class="code-display-section" id="codeDisplaySection">
                <h3 class="qr-title">Your Pairing Code</h3>
                <div class="code-display" id="pairingCodeDisplay">0000-0000</div>
                <p class="code-info" id="codeInfo">
                    Code expires in <span id="expiryTimer">10:00</span>
                </p>
                <p>Use this code in WhatsApp: Settings → Linked Devices → Link a Device → "Use pairing code instead"</p>
            </div>
            
            <div class="instructions">
                <h3>How to Use Your Pairing Code</h3>
                <ol>
                    <li>Enter your phone number with country code</li>
                    <li>Click "Generate Pairing Code" to get your 8-digit code</li>
                    <li>Open WhatsApp on your phone</li>
                    <li>Go to: <strong>Settings → Linked Devices → Link a Device</strong></li>
                    <li>Tap <strong>"Use pairing code instead"</strong></li>
                    <li>Enter the 8-digit code shown above</li>
                    <li>Your WhatsApp will be linked to this service</li>
                </ol>
                <p><strong>Note:</strong> The pairing code is valid for ${CONFIG.CODE_EXPIRY_MINUTES} minutes only.</p>
            </div>
            
            <div class="footer">
                <p>⚡ Powered by <a href="${CONFIG.COMPANY_WEBSITE}" target="_blank">${CONFIG.COMPANY_NAME}</a></p>
                <p>📞 Support: <a href="tel:${CONFIG.COMPANY_CONTACT}">${CONFIG.COMPANY_CONTACT}</a> | 📧 <a href="mailto:${CONFIG.COMPANY_EMAIL}">${CONFIG.COMPANY_EMAIL}</a></p>
                <p>© ${new Date().getFullYear()} ${CONFIG.COMPANY_NAME}. All rights reserved.</p>
            </div>
        </div>
        
        <div class="notification" id="notification"></div>
        
        <script>
            let currentCode = '';
            let currentPhone = '';
            let expiryInterval = null;
            
            // Phone number input validation
            document.getElementById('phoneNumber').addEventListener('input', function(e) {
                let value = e.target.value.replace(/\D/g, '');
                e.target.value = value;
            });
            
            async function generatePairingCode() {
                const phoneInput = document.getElementById('phoneNumber');
                const phone = phoneInput.value.replace(/\D/g, '');
                
                if (!phone) {
                    showNotification('❌ Please enter your phone number', 'error');
                    phoneInput.focus();
                    return;
                }
                
                if (phone.length < 5) {
                    showNotification('❌ Phone number too short', 'error');
                    phoneInput.focus();
                    return;
                }
                
                const fullNumber = '+254' + phone;
                
                try {
                    const response = await fetch('/generate-code', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            phoneNumber: fullNumber
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        currentCode = data.displayCode;
                        currentPhone = data.phoneNumber;
                        
                        // Update display
                        document.getElementById('pairingCodeDisplay').textContent = currentCode;
                        document.getElementById('codeDisplaySection').style.display = 'block';
                        document.getElementById('qrSection').style.display = 'none';
                        
                        // Update info
                        document.getElementById('codeInfo').innerHTML = \`
                            Generated for: <strong>\${currentPhone}</strong><br>
                            Expires in: <span id="expiryTimer">10:00</span>
                        \`;
                        
                        // Start expiry timer
                        if (data.expiresAt) {
                            startExpiryTimer(data.expiresAt);
                        }
                        
                        // Update stats
                        updateStats();
                        
                        showNotification(\`✅ Pairing code generated: \${currentCode}\`, 'success');
                    } else {
                        showNotification('❌ ' + (data.message || 'Failed to generate code'), 'error');
                    }
                } catch (error) {
                    console.error('Error:', error);
                    showNotification('❌ Network error. Please try again.', 'error');
                }
            }
            
            async function showQRCode() {
                try {
                    const response = await fetch('/getqr');
                    const data = await response.json();
                    
                    if (data.success && data.qrImage) {
                        document.getElementById('qrImage').src = data.qrImage;
                        document.getElementById('qrSection').style.display = 'block';
                        document.getElementById('codeDisplaySection').style.display = 'none';
                        showNotification('✅ QR Code loaded successfully', 'success');
                    } else {
                        showNotification('⚠️ ' + (data.message || 'QR code not available yet'), 'warning');
                    }
                } catch (error) {
                    console.error('Error:', error);
                    showNotification('❌ Error loading QR code', 'error');
                }
            }
            
            function copyToClipboard() {
                if (!currentCode) {
                    showNotification('❌ No code to copy', 'warning');
                    return;
                }
                
                navigator.clipboard.writeText(currentCode).then(() => {
                    showNotification(\`✅ Copied to clipboard: \${currentCode}\`, 'success');
                }).catch(err => {
                    showNotification('❌ Could not copy to clipboard', 'error');
                });
            }
            
            function startExpiryTimer(expiryTime) {
                if (expiryInterval) clearInterval(expiryInterval);
                
                const expiryDate = new Date(expiryTime);
                
                function updateTimer() {
                    const now = new Date();
                    const diff = expiryDate - now;
                    
                    if (diff <= 0) {
                        document.getElementById('expiryTimer').textContent = 'EXPIRED';
                        clearInterval(expiryInterval);
                        showNotification('⚠️ This pairing code has expired. Generate a new one.', 'warning');
                        return;
                    }
                    
                    const minutes = Math.floor(diff / 60000);
                    const seconds = Math.floor((diff % 60000) / 1000);
                    
                    document.getElementById('expiryTimer').textContent = 
                        \`\${minutes.toString().padStart(2, '0')}:\${seconds.toString().padStart(2, '0')}\`;
                }
                
                updateTimer();
                expiryInterval = setInterval(updateTimer, 1000);
            }
            
            async function updateStats() {
                try {
                    const response = await fetch('/status');
                    const data = await response.json();
                    
                    // Update status badge
                    const statusBadge = document.getElementById('statusBadge');
                    statusBadge.textContent = data.statusText || 'Unknown';
                    statusBadge.style.backgroundColor = data.statusColor || '#6c757d';
                    
                    // Update stats
                    document.getElementById('pairingCount').textContent = data.pairingCodes || 0;
                    if (data.lastCode) {
                        document.getElementById('lastCode').textContent = data.lastCode;
                    }
                    document.getElementById('qrAttempts').textContent = data.qrAttempts || 0;
                    
                } catch (error) {
                    console.log('Status update failed:', error);
                }
            }
            
            function showNotification(message, type) {
                const notification = document.getElementById('notification');
                notification.textContent = message;
                
                // Set color based on type
                if (type === 'success') {
                    notification.style.background = '#28a745';
                } else if (type === 'error') {
                    notification.style.background = '#dc3545';
                } else if (type === 'warning') {
                    notification.style.background = '#ffc107';
                    notification.style.color = '#333';
                } else {
                    notification.style.background = '#17a2b8';
                }
                
                notification.style.display = 'block';
                
                // Auto-hide after 3 seconds
                setTimeout(() => {
                    notification.style.display = 'none';
                }, 3000);
            }
            
            // Auto-update stats every 5 seconds
            setInterval(updateStats, 5000);
            
            // Initial update
            updateStats();
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

app.post('/generate-code', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ 
                success: false, 
                message: 'Phone number is required' 
            });
        }
        
        const validation = validateAndFormatPhoneNumber(phoneNumber);
        
        if (!validation.isValid) {
            return res.status(400).json({ 
                success: false, 
                message: validation.error 
            });
        }
        
        const codeData = generateNewPairingCode(validation.formatted, validation.country);
        
        res.json({ 
            success: true,
            code: codeData.code,
            displayCode: codeData.displayCode,
            phoneNumber: validation.formatted,
            country: validation.country,
            expiresAt: codeData.expiresAt,
            message: 'Pairing code generated successfully!',
        });
        
    } catch (error) {
        console.error('Error generating pairing code:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error while generating code' 
        });
    }
});

app.get('/getqr', async (req, res) => {
    try {
        if (botStatus === 'qr_ready' && qrImageDataUrl) {
            res.json({
                success: true,
                qrImage: qrImageDataUrl,
                message: 'Scan this QR code in WhatsApp',
                status: botStatus
            });
        } else {
            res.json({ 
                success: false, 
                message: 'QR code not available yet. Please wait for connection...',
                status: botStatus,
                qrAttempts: autoActivationAttempts,
                maxAttempts: CONFIG.MAX_QR_ATTEMPTS
            });
        }
    } catch (error) {
        console.error('Error getting QR code:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error getting QR code' 
        });
    }
});

app.get('/status', (req, res) => {
    res.json({
        status: botStatus,
        statusText: getStatusText(botStatus),
        statusColor: getStatusColor(botStatus),
        pairingCodes: pairingCodes.size,
        lastCode: lastGeneratedDisplayCode,
        qrAttempts: autoActivationAttempts,
        maxQrAttempts: CONFIG.MAX_QR_ATTEMPTS,
        qrReady: botStatus === 'qr_ready',
        online: botStatus === 'online',
        company: CONFIG.COMPANY_NAME,
        version: CONFIG.VERSION,
        lastConnectionUpdate: lastConnectionUpdate,
        uptime: process.uptime()
    });
});

// ==================== START SERVER ====================
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(60));
    console.log(`🚀 ${CONFIG.COMPANY_NAME} WhatsApp Pairing Service v${CONFIG.VERSION}`);
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`📱 Visit: http://localhost:${PORT}`);
    console.log(`⚡ Auto-Activation: ${CONFIG.AUTO_ACTIVATED ? 'ENABLED' : 'DISABLED'}`);
    console.log(`📞 Support: ${CONFIG.COMPANY_CONTACT}`);
    console.log('='.repeat(60) + '\n');
    
    // Initialize WhatsApp connection
    setTimeout(() => {
        console.log('Initializing WhatsApp connection...');
        initWhatsApp();
    }, 2000);
});

// Handle cleanup on exit
process.on('SIGINT', () => {
    console.log(`\n🛑 ${CONFIG.COMPANY_NAME} - Shutting down gracefully...`);
    
    if (activeSocket) {
        console.log('Closing WhatsApp connection...');
        activeSocket.end();
    }
    
    process.exit(0);
});
