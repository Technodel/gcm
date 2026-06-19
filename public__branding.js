/**
 * branding.js — Galaxy Universal Footer
 * ======================================
 * Include this script at the bottom of any HTML page to inject
 * the Galaxy branding footer. Edit only this file to change branding.
 *
 *   <script src="http://localhost:3051/branding.js"></script>
 */
(function () {
    'use strict';
    // Don't show footer if we are inside an iframe (like the Whatsapp Suite)
    if (window.self !== window.top) return;

    const isTalkie = document.title.toLowerCase().includes('talkie');
    const isMultiPlatform = document.title.toLowerCase().includes('automator') || document.title.toLowerCase().includes('multiplatform') || document.title.toLowerCase().includes('locker');

    // --- Inject CSS ---
    const style = document.createElement('style');
    style.id = 'galaxy-branding-styles';
    style.textContent = `
        #galaxy-footer {
            position: ${isTalkie || isMultiPlatform ? 'absolute' : 'fixed'};
            bottom: ${isTalkie ? '80px' : '15px'};
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            align-items: center;
            gap: 10px;
            z-index: 999999;
            pointer-events: none;
            background: rgba(0, 0, 0, 0.45);
            padding: 6px 16px 6px 10px;
            border-radius: 999px;
            border: 1px solid rgba(255,255,255,0.12);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            white-space: nowrap;
            font-family: 'Segoe UI', Arial, sans-serif;
            transition: opacity 0.3s;
        }
        #galaxy-footer .gx-logos {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        #galaxy-footer img {
            width: 56px;
            height: 56px;

            border-radius: 50%;
            object-fit: contain;
            background: transparent;
            border: 1.5px solid rgba(255,255,255,0.1);
            flex-shrink: 0;
        }
        #galaxy-footer img.gx-logo-galaxy {
            object-fit: cover;
            border-color: rgba(255,200,80,0.5);
        }
        #galaxy-footer .gx-text {
            display: flex;
            flex-direction: column;
            line-height: 1.2;
        }
        #galaxy-footer .gx-by   { font-size: 11.5px; font-weight: 700; color: #f0e6c8; letter-spacing: 0.3px; }
        #galaxy-footer .gx-num  { font-size: 9.5px; color: #94a3b8; letter-spacing: 0.5px; }

        /* Light Theme Auto-Support */
        body.gx-light-theme #galaxy-footer {
            background: rgba(255, 255, 255, 0.85);
            border: 1px solid rgba(0,0,0,0.15);
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        }
        body.gx-light-theme #galaxy-footer .gx-by { color: #1e293b; }
        body.gx-light-theme #galaxy-footer .gx-num { color: #64748b; }
    `;
    document.head.appendChild(style);

    // --- Inject HTML ---
    const technodelLogoHtml = '';


    // Determine base URL from current script src
    const scriptSrc = document.currentScript ? document.currentScript.src : '';
    const baseUrl = scriptSrc ? scriptSrc.substring(0, scriptSrc.lastIndexOf('/') + 1) : 'http://localhost:3051/';

    const footer = document.createElement('div');
    footer.id = 'galaxy-footer';
    footer.innerHTML = `
        <div class="gx-logos">
            ${technodelLogoHtml}
            <img src="${baseUrl}galaxy.png" alt="Galaxy" class="gx-logo-galaxy">
        </div>
        <div class="gx-text">
            <span class="gx-by">By Galaxy</span>
            <span class="gx-num">03659872</span>
        </div>
    `;

    // For Talkie, place it inside the main container if possible to follow the app flow
    const targetParent = isTalkie ? (document.querySelector('.main') || document.body) : document.body;
    targetParent.appendChild(footer);

    // Theme detection
    function checkTheme() {
        const bg = window.getComputedStyle(document.body).backgroundColor;
        const isLight = bg === 'rgb(255, 255, 255)' || bg === 'white' || document.querySelector('.stApp');
        if (isLight) {
            document.body.classList.add('gx-light-theme');
        } else {
            document.body.classList.remove('gx-light-theme');
        }
    }

    if (document.readyState === 'complete') {
        checkTheme();
    } else {
        window.addEventListener('load', checkTheme);
    }

    setInterval(checkTheme, 2000);
})();
