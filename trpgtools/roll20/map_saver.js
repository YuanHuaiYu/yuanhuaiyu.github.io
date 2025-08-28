(function() {
    'use strict';
    /**
     * 負責擷取、拼接並儲存 Roll20 地圖為完整的圖片。
     * 使用方法：
     * 1. 在 Roll20 遊戲房間內打開瀏覽器開發者工具 (F12)。
     * 2. 確定有開啟顯示縮放介面，若無則必須開啟。
     * 3. 將此腳本完整貼到 Console 中並執行。
     * 4. 可在 `new Roll20MapSaver(100)` 中傳入想要的縮放百分比。
     * 5. 地圖縮圖將出現在左上角，右鍵可另存，左鍵可刪除。
     */
    class Roll20MapSaver {
        constructor(zoomSize = 100) {
            this.config = {
                frameRetries: 10,
                gridCellSize: 70,
                zoomLevels: [10, 50, 75, 100, 150, 200, 250],
                uiWaitTimeout: 2000, // 等待 UI 反應的超時時間 (ms)
                selectors: {
                    editorWrapper: '#editor-wrapper',
                    editor: '#editor',
                    canvas: '#babylonCanvas',
                    zoomLevel: '#vm_zoom_buttons .level',
                    sidebarToggle: '#sidebarcontrol',
                    sidebarHidden: 'body.sidebarhidden #rightsidebar',
                    zoomMenuButtons: '.zoomDubMenuBtnStyle .el-button',
                    outputImage: '#roll20-map-save',
                },
            };

            this.zoom = this.config.zoomLevels.find(z => z >= zoomSize) || 100;
            this.reRenderZoom = this.zoom === 250 ? 200 : this.config.zoomLevels.find(z => z > this.zoom);

            this.state = {
                originalZoom: 100,
                isJumpGate: false,
                shouldRestoreSidebar: false,
                elements: {}
            };
        }

        /**
         * 執行地圖儲存程序
         */
        async run() {
            try {
                console.log('正在初始化地圖儲存程序...');
                await this.initialize();

                console.log('開始擷取地圖圖塊...');
                const mapDataUrl = await this.captureMap();

                console.log('正在產生最終圖片...');
                await this.displayResult(mapDataUrl);

                console.log('地圖儲存成功！縮圖已顯示在左上角。');
            } catch (error) {
                console.error(`儲存地圖時發生錯誤: ${error.message}`, error);
            } finally {
                console.log('正在清理並還原設定...');
                await this.cleanup();
            }
        }

        /**
         * 初始化，獲取 DOM 元素並設定環境
         */
        async initialize() {
            // 預先查詢並快取所有需要的 DOM 元素
            this.state.elements.zoomLevel = document.querySelector(this.config.selectors.zoomLevel);
            this.state.elements.editorWrapper = document.querySelector(this.config.selectors.editorWrapper);
            this.state.elements.editor = document.querySelector(this.config.selectors.editor);
            this.state.elements.finalCanvas = document.querySelector(this.config.selectors.canvas);

            if (!this.state.elements.zoomLevel || !this.state.elements.editorWrapper || !this.state.elements.editor || !this.state.elements.finalCanvas) {
                throw new Error('找不到必要的遊戲元件。請確認您在 Roll20 頁面中，且縮放介面可見。');
            }

            this.state.originalZoom = this.config.zoomLevels.find(z => z >= Number(this.state.elements.zoomLevel.textContent)) || 100;
            this.state.isJumpGate = !!window.Campaign.view.model.engine;

            // 為了最大化擷取區域，如果側邊欄是開的就關閉它
            if (this.state.isJumpGate && !document.querySelector(this.config.selectors.sidebarHidden)) {
                this.state.shouldRestoreSidebar = true;
                document.querySelector(this.config.selectors.sidebarToggle).click();
                await this.waitForUI(100); // 等待側邊欄動畫
            }
        }

        /**
         * 擷取整個地圖
         * @returns {Promise<string>} 包含地圖圖片的 Data URL
         */
        async captureMap() {
            const scale = this.zoom / 100;
            const page = window.Campaign.activePage();
            const width = page.get('width') * this.config.gridCellSize * scale;
            const height = page.get('height') * this.config.gridCellSize * scale;

            const outputCanvas = document.createElement('canvas');
            outputCanvas.width = width;
            outputCanvas.height = height;
            const ctx = outputCanvas.getContext('2d', { willReadFrequently: true });

            await this.setZoom(this.zoom);

            const { editor, finalCanvas } = this.state.elements;
            // 增加額外的 padding，確保即使是地圖的右下角也能被完整地滾動到視窗的左上角，從而能被完整擷取。
            editor.style.paddingRight = `${finalCanvas.width / scale * 2}px`;
            editor.style.paddingBottom = `${finalCanvas.height / scale * 2}px`;

            const editorStyle = getComputedStyle(editor);
            const paddingTop = this.state.isJumpGate ? 0 : parseInt(editorStyle.paddingTop, 10);
            const paddingLeft = this.state.isJumpGate ? 0 : parseInt(editorStyle.paddingLeft, 10);

            const tileCount = Math.ceil(width / finalCanvas.width) * Math.ceil(height / finalCanvas.height);
            let progress = 0;

            for (let oy = 0; oy < height; oy += finalCanvas.height) {
                for (let ox = 0; ox < width; ox += finalCanvas.width) {
                    this.scrollCanvas(ox, oy, scale, paddingTop, paddingLeft);
                    await this.awaitNextFrame(); // 等待滾動生效
                    await this.captureTile(ctx, ox, oy, width, height, scale);
                    console.log(`進度: ${Math.floor(++progress / tileCount * 100)}%`);
                }
            }

            const url = outputCanvas.toDataURL();
            if (!url || url === 'data:,') {
                throw new Error('無法產生圖片 Data URL。地圖可能太大了。');
            }
            return url;
        }

        /**
         * 捲動畫布到指定位置
         */
        scrollCanvas(ox, oy, scale, paddingTop, paddingLeft) {
            const { editorWrapper } = this.state.elements;
            if (this.state.isJumpGate) {
                const engine = window.Campaign.view.model.engine;
                engine.cameraTransform.position.y = -oy / scale + paddingTop * scale - engine.canvas.height / scale / 2;
                engine.cameraTransform.position.x = ox / scale + paddingLeft * scale + engine.canvas.width / scale / 2;
            } else {
                editorWrapper.scrollTop = oy + paddingTop * scale;
                editorWrapper.scrollLeft = ox + paddingLeft * scale;
            }
        }

        /**
         * 擷取單一圖塊，包含重試邏輯
         */
        async captureTile(ctx, ox, oy, mapWidth, mapHeight, scale) {
            const { finalCanvas } = this.state.elements;
            for (let i = 0; i < this.config.frameRetries; i++) {
                // Roll20 的 Babylon.js 畫布有時不會在滾動後立即重繪。
                // 透過快速切換縮放等級，可以強制觸發一次完整的重繪，確保擷取到的是最新的畫面。
                await this.setZoom(this.reRenderZoom);
                await this.setZoom(this.zoom);
                window.Campaign.view.render();

                // 每次重試時，增加等待的幀數，給予渲染器更充裕的時間
                for (let j = 0; j <= i; j++) await this.awaitNextFrame();

                const destX = Math.floor(ox + finalCanvas.parentElement.offsetLeft * scale);
                const destY = Math.floor(oy + finalCanvas.parentElement.offsetTop * scale);
                ctx.drawImage(finalCanvas, destX, destY);

                // 檢查擷取圖塊的頂部和底部邊緣是否存在透明像素。
                // 如果有，代表渲染尚未完成（或失敗），需要重試。
                const tileWidth = Math.min(mapWidth - destX, finalCanvas.width);
                const imageDataTop = ctx.getImageData(destX, destY, tileWidth, 1);
                const imageDataBottom = ctx.getImageData(destX, Math.min(mapHeight - 1, destY + finalCanvas.height - 1), tileWidth, 1);

                const hasTransparentPixels = (d) => {
                    for (let k = 3; k < d.length; k += 4) if (d[k] === 0) return true;
                    return false;
                };

                if (!hasTransparentPixels(imageDataTop.data) && !hasTransparentPixels(imageDataBottom.data)) {
                    return; // 渲染成功，結束重試
                }
            }
            console.warn(`無法在 ${this.config.frameRetries} 次重試後成功渲染圖塊 [${ox}, ${oy}]。結果中可能會有瑕疵。`);
        }

        /**
         * 在頁面上顯示最終的圖片縮圖
         * @param {string} url - 圖片的 Data URL
         */
        async displayResult(url) {
            document.querySelector(this.config.selectors.outputImage)?.remove();

            const img = document.createElement('img');
            img.id = this.config.selectors.outputImage.substring(1);
            Object.assign(img.style, {
                position: 'fixed', top: '1rem', left: '8rem', width: '10rem',
                zIndex: '10000000', cursor: 'pointer', border: 'solid 1px red',
            });
            img.title = '右鍵點擊 -> 另存圖片/在新分頁中開啟圖片，左鍵點擊可刪除';
            img.onclick = () => img.remove();

            document.body.appendChild(img);

            return new Promise((resolve, reject) => {
                img.onload = () => img.height ? resolve() : reject(new Error('圖片渲染失敗，可能是地圖尺寸過大。'));
                img.onerror = () => reject(new Error('圖片載入失敗，可能是地圖尺寸過大。'));
                img.src = url;
            });
        }

        /**
         * 清理並還原頁面狀態
         */
        async cleanup() {
            if (this.state.elements.editor) {
                this.state.elements.editor.style.paddingRight = null;
                this.state.elements.editor.style.paddingBottom = null;
            }
            await this.setZoom(this.state.originalZoom);
            if (document.querySelectorAll(this.config.selectors.zoomMenuButtons).length > 0) {
                this.state.elements.zoomLevel.click();
            }
            if (this.state.shouldRestoreSidebar) {
                document.querySelector(this.config.selectors.sidebarToggle).click();
            }
        }

        /**
         * 設定 Roll20 的縮放等級
         * @param {number} zoom - 目標縮放百分比
         */
        async setZoom(zoom) {
            try {
                const { zoomLevel } = this.state.elements;
                if (Number(zoomLevel.textContent) === zoom) return;

                // 如果縮放選單尚未開啟，則點擊按鈕將其開啟
                if (document.querySelectorAll(this.config.selectors.zoomMenuButtons).length === 0) {
                    zoomLevel.click();
                    await this.waitForUI(() => document.querySelectorAll(this.config.selectors.zoomMenuButtons).length > 0);
                }

                const buttons = Array.from(document.querySelectorAll(this.config.selectors.zoomMenuButtons));
                const targetButton = buttons.find(btn => (parseFloat(btn.textContent.match(/\d+%/)) || 0) === zoom);

                if (targetButton) {
                    targetButton.click();
                    await this.waitForUI(() => Number(document.querySelector(this.config.selectors.zoomLevel)?.textContent) === zoom);
                } else {
                    throw new Error(`找不到 ${zoom}% 的縮放按鈕`);
                }
            } catch (err) {
                console.warn(`設定縮放至 ${zoom}% 失敗: ${err.message}。將嘗試重設為 100%。`);
                if (zoom !== 100) await this.setZoom(100);
            }
        }

        /**
         * 等待下一個動畫幀
         * @returns {Promise<void>}
         */
        awaitNextFrame() {
            return new Promise(resolve => requestAnimationFrame(resolve));
        }

        /**
         * 等待 UI 更新或固定延遲
         * @param {Function|number} conditionOrDelay - 輪詢的條件函式或等待的毫秒數
         */
        async waitForUI(conditionOrDelay) {
            if (typeof conditionOrDelay === 'number') {
                return new Promise(r => setTimeout(r, conditionOrDelay));
            }

            const poll = (resolve, reject) => {
                if (conditionOrDelay()) resolve();
                else if (Date.now() - startTime > this.config.uiWaitTimeout) reject(new Error('等待 UI 反應超時。'));
                else setTimeout(() => poll(resolve, reject), 50);
            };
            const startTime = Date.now();
            return new Promise(poll);
        }
    }

    // 執行時可設定截取的縮放百分比為: 10, 50, 75, 100, 150, 200, 250
    new Roll20MapSaver(100).run();

})();
