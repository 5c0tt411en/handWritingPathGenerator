let detector;
let currentImage = null;
let correctedImageData = null;
let selectedFiles = [];
let processedResults = [];

// ページ読み込み後にディテクタを初期化
window.addEventListener('load', function() {
    if (typeof AR !== 'undefined') {
        // ハミング距離の許容値を少し緩める（ノイズに強くなる）
        detector = new AR.Detector({
            dictionaryName: 'ARUCO',
            maxHammingDistance: 3
        });
        console.log('ArUco detector initialized with relaxed parameters');
    }
});

// 画像の前処理（コントラスト強調）
function preprocessImage(imageData) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    // グレースケールに変換してヒストグラムを計算
    const histogram = new Array(256).fill(0);
    const grayValues = new Uint8Array(width * height);

    for (let i = 0; i < data.length; i += 4) {
        const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        grayValues[i / 4] = gray;
        histogram[gray]++;
    }

    // コントラストストレッチング（パーセンタイルベース）
    const totalPixels = width * height;
    const lowPercentile = 0.01;
    const highPercentile = 0.99;

    let cumSum = 0;
    let lowValue = 0;
    let highValue = 255;

    for (let i = 0; i < 256; i++) {
        cumSum += histogram[i];
        if (cumSum / totalPixels < lowPercentile) {
            lowValue = i;
        }
        if (cumSum / totalPixels < highPercentile) {
            highValue = i;
        }
    }

    // コントラストを強調
    const range = highValue - lowValue || 1;
    const enhanced = new ImageData(width, height);

    for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            let val = data[i + c];
            val = ((val - lowValue) * 255) / range;
            val = Math.max(0, Math.min(255, val));
            enhanced.data[i + c] = Math.round(val);
        }
        enhanced.data[i + 3] = 255;
    }

    return enhanced;
}

// シャープ化フィルタ
function sharpenImage(imageData) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;
    const output = new ImageData(width, height);

    // シャープ化カーネル
    const kernel = [
        0, -1, 0,
        -1, 5, -1,
        0, -1, 0
    ];

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const idx = ((y + ky) * width + (x + kx)) * 4 + c;
                        sum += data[idx] * kernel[(ky + 1) * 3 + (kx + 1)];
                    }
                }
                const outIdx = (y * width + x) * 4 + c;
                output.data[outIdx] = Math.max(0, Math.min(255, sum));
            }
            output.data[(y * width + x) * 4 + 3] = 255;
        }
    }

    // 境界をコピー
    for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) {
            output.data[x * 4 + c] = data[x * 4 + c];
            output.data[((height - 1) * width + x) * 4 + c] = data[((height - 1) * width + x) * 4 + c];
        }
    }
    for (let y = 0; y < height; y++) {
        for (let c = 0; c < 4; c++) {
            output.data[(y * width) * 4 + c] = data[(y * width) * 4 + c];
            output.data[(y * width + width - 1) * 4 + c] = data[(y * width + width - 1) * 4 + c];
        }
    }

    return output;
}

// 複数の前処理を試してマーカーを検出
function detectMarkersWithPreprocessing(img) {
    const statusEl = document.getElementById('status');
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const originalData = ctx.getImageData(0, 0, img.width, img.height);

    // 検出方法のリスト
    const methods = [
        { name: '元画像', data: originalData },
        { name: 'コントラスト強調', data: preprocessImage(originalData) },
        { name: 'シャープ化', data: sharpenImage(originalData) },
        { name: 'コントラスト+シャープ', data: sharpenImage(preprocessImage(originalData)) }
    ];

    let bestResult = { markers: [], method: '' };
    let attemptLog = [];

    for (const method of methods) {
        statusEl.textContent = `検出中: ${method.name}...`;
        try {
            const markers = detector.detect(method.data);

            // ID 0-3のマーカーをカウント
            const validIds = new Set([0, 1, 2, 3]);
            const foundValidMarkers = markers.filter(m => validIds.has(m.id));
            const foundIds = foundValidMarkers.length;

            attemptLog.push(`${method.name}: ID 0-3を${foundIds}個検出`);
            console.log(`${method.name}: 全${markers.length}個, ID 0-3: ${foundIds}個`, foundValidMarkers.map(m => `ID${m.id}`));

            if (foundIds > bestResult.markers.filter(m => validIds.has(m.id)).length) {
                bestResult = { markers: markers, method: method.name };
            }

            // 4つすべて見つかったら終了
            if (foundIds >= 4) {
                console.log(`✓ ${method.name}で全マーカーを検出`);
                statusEl.textContent = `✓ ${method.name}で全マーカー検出成功`;
                return { markers: markers, processedData: method.data, log: attemptLog };
            }
        } catch (e) {
            console.warn(`${method.name}での検出に失敗:`, e);
            attemptLog.push(`${method.name}: エラー`);
        }
    }

    // 画像をダウンスケールして再試行（大きい画像の場合）
    if (img.width > 2000 || img.height > 2000) {
        statusEl.textContent = '高解像度画像 - ダウンスケールで再試行...';
        console.log('高解像度画像を検出 - ダウンスケールで再試行...');

        const scales = [0.5, 0.75, 0.25];
        for (const scale of scales) {
            const scaledCanvas = document.createElement('canvas');
            scaledCanvas.width = Math.round(img.width * scale);
            scaledCanvas.height = Math.round(img.height * scale);
            const scaledCtx = scaledCanvas.getContext('2d');
            scaledCtx.drawImage(img, 0, 0, scaledCanvas.width, scaledCanvas.height);
            const scaledData = scaledCtx.getImageData(0, 0, scaledCanvas.width, scaledCanvas.height);

            const preprocessMethods = [
                { name: `スケール${scale * 100}%`, data: scaledData },
                { name: `スケール${scale * 100}%+コントラスト`, data: preprocessImage(scaledData) }
            ];

            for (const method of preprocessMethods) {
                try {
                    const markers = detector.detect(method.data);

                    // 座標をスケールアップ
                    markers.forEach(marker => {
                        marker.corners = marker.corners.map(corner => ({
                            x: corner.x / scale,
                            y: corner.y / scale
                        }));
                    });

                    const validIds = new Set([0, 1, 2, 3]);
                    const foundValidMarkers = markers.filter(m => validIds.has(m.id));
                    const foundIds = foundValidMarkers.length;

                    attemptLog.push(`${method.name}: ID 0-3を${foundIds}個検出`);
                    console.log(`${method.name}: ${foundIds}個のマーカーを検出`);

                    if (foundIds > bestResult.markers.filter(m => validIds.has(m.id)).length) {
                        bestResult = { markers: markers, method: method.name };
                    }

                    if (foundIds >= 4) {
                        console.log(`✓ ${method.name}で全マーカーを検出`);
                        statusEl.textContent = `✓ ${method.name}で全マーカー検出成功`;
                        return { markers: markers, processedData: originalData, log: attemptLog };
                    }
                } catch (e) {
                    console.warn(`${method.name}での検出に失敗:`, e);
                }
            }
        }
    }

    console.log(`最良の結果: ${bestResult.method} (${bestResult.markers.length}個)`);
    console.log('検出試行ログ:', attemptLog);
    return { markers: bestResult.markers, processedData: originalData, log: attemptLog };
}

document.getElementById('imageInput').addEventListener('change', function(e) {
    selectedFiles = Array.from(e.target.files);
    processedResults = [];

    // ファイルリストを更新
    const fileListEl = document.getElementById('fileList');
    fileListEl.innerHTML = '';
    selectedFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.id = `file-${index}`;
        item.textContent = file.name;
        fileListEl.appendChild(item);
    });

    // ボタンを有効化
    document.getElementById('batchProcessBtn').disabled = selectedFiles.length === 0;

    // 最初のファイルを処理
    if (selectedFiles.length > 0) {
        const reader = new FileReader();
        reader.onload = function(event) {
            const img = new Image();
            img.onload = function() {
                currentImage = img;
                processImage(img);
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(selectedFiles[0]);
    }
});

function reprocess() {
    if (currentImage) {
        processImage(currentImage);
    } else if (correctedImageData) {
        processColorImage(correctedImageData);
    }
}

function processImage(img) {
    const statusEl = document.getElementById('status');
    statusEl.className = 'status loading';
    statusEl.textContent = 'ARマーカーを検出中...（複数の方法で試行）';

    try {
        // 1. 元画像を表示
        const originalCanvas = document.getElementById('originalCanvas');
        const ctx = originalCanvas.getContext('2d');
        originalCanvas.width = img.width;
        originalCanvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        // 複数の前処理を試してマーカーを検出
        const result = detectMarkersWithPreprocessing(img);
        const markers = result.markers;

        console.log(`検出されたマーカー数: ${markers.length}`);

        // ID 0-3のマーカーをフィルタリング
        const validMarkers = markers.filter(m => m.id >= 0 && m.id <= 3);

        if (validMarkers.length < 4) {
            // 検出されたマーカーを表示（デバッグ用）
            markers.forEach(marker => {
                ctx.strokeStyle = marker.id >= 0 && marker.id <= 3 ? '#00ff00' : '#ffff00';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(marker.corners[0].x, marker.corners[0].y);
                for (let i = 1; i < marker.corners.length; i++) {
                    ctx.lineTo(marker.corners[i].x, marker.corners[i].y);
                }
                ctx.closePath();
                ctx.stroke();

                const centerX = (marker.corners[0].x + marker.corners[2].x) / 2;
                const centerY = (marker.corners[0].y + marker.corners[2].y) / 2;
                ctx.fillStyle = '#ff0000';
                ctx.font = 'bold 24px Arial';
                ctx.fillText('ID:' + marker.id, centerX - 20, centerY);
            });

            const foundIds = validMarkers.map(m => m.id).join(', ');
            throw new Error(`ARマーカーID 0-3のうち${validMarkers.length}個しか検出されませんでした（検出ID: ${foundIds || 'なし'}）。4個必要です。`);
        }

        // マーカーを描画
        markers.forEach(marker => {
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(marker.corners[0].x, marker.corners[0].y);
            for (let i = 1; i < marker.corners.length; i++) {
                ctx.lineTo(marker.corners[i].x, marker.corners[i].y);
            }
            ctx.closePath();
            ctx.stroke();

            const centerX = (marker.corners[0].x + marker.corners[2].x) / 2;
            const centerY = (marker.corners[0].y + marker.corners[2].y) / 2;
            ctx.fillStyle = '#00ff00';
            ctx.font = 'bold 20px Arial';
            ctx.fillText('ID:' + marker.id, centerX - 20, centerY);
        });

        // 2. マーカーの内側の角から描画エリアを推定
        statusEl.textContent = '描画エリアを補正中...';

        const markerMap = {};
        markers.forEach(marker => {
            if (marker.id >= 0 && marker.id <= 3) {
                markerMap[marker.id] = marker;
            }
        });

        if (Object.keys(markerMap).length < 4) {
            throw new Error('ID 0-3のマーカーが全て検出されませんでした');
        }

        // 内側への余白計算
        const insetMm = parseFloat(document.getElementById('insetMargin').value);
        const marker0 = markerMap[0].corners;
        const markerWidthPx = Math.sqrt(
            Math.pow(marker0[1].x - marker0[0].x, 2) +
            Math.pow(marker0[1].y - marker0[0].y, 2)
        );
        const markerHeightPx = Math.sqrt(
            Math.pow(marker0[3].x - marker0[0].x, 2) +
            Math.pow(marker0[3].y - marker0[0].y, 2)
        );
        const markerSizePx = (markerWidthPx + markerHeightPx) / 2;

        const templateMarkerSizeMm = 20;
        const mmToPx = markerSizePx / templateMarkerSizeMm;
        const insetPx = insetMm * mmToPx;

        // 画像スケールを取得（テンプレートと同じ値）
        const imageScale = parseFloat(document.getElementById('imageScale').value) / 100;

        // まず描画枠のコーナーを計算
        const frameCorners = [
            {
                x: markerMap[0].corners[2].x + insetPx,
                y: markerMap[0].corners[2].y + insetPx
            },
            {
                x: markerMap[1].corners[3].x - insetPx,
                y: markerMap[1].corners[3].y + insetPx
            },
            {
                x: markerMap[2].corners[0].x - insetPx,
                y: markerMap[2].corners[0].y - insetPx
            },
            {
                x: markerMap[3].corners[1].x + insetPx,
                y: markerMap[3].corners[1].y - insetPx
            }
        ];

        // 描画枠の中心を計算
        const frameCenterX = (frameCorners[0].x + frameCorners[1].x + frameCorners[2].x + frameCorners[3].x) / 4;
        const frameCenterY = (frameCorners[0].y + frameCorners[1].y + frameCorners[2].y + frameCorners[3].y) / 4;

        // 画像スケールに基づいて、実際の画像領域のコーナーを計算
        // 描画枠の中心から、imageScale倍に縮小した領域
        const drawingAreaCorners = frameCorners.map(corner => ({
            x: frameCenterX + (corner.x - frameCenterX) * imageScale,
            y: frameCenterY + (corner.y - frameCenterY) * imageScale
        }));

        // 描画枠を薄いグレーで表示
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(frameCorners[0].x, frameCorners[0].y);
        for (let i = 1; i < frameCorners.length; i++) {
            ctx.lineTo(frameCorners[i].x, frameCorners[i].y);
        }
        ctx.closePath();
        ctx.stroke();

        // 画像領域を赤で表示
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(drawingAreaCorners[0].x, drawingAreaCorners[0].y);
        for (let i = 1; i < drawingAreaCorners.length; i++) {
            ctx.lineTo(drawingAreaCorners[i].x, drawingAreaCorners[i].y);
        }
        ctx.closePath();
        ctx.stroke();

        console.log(`画像スケール: ${imageScale * 100}%, 切り取り領域: 描画枠の中央${imageScale * 100}%`);

        // 3. パース補正
        const outputSize = 4096;
        const corrected = perspectiveTransformColor(img, drawingAreaCorners, outputSize);

        // 補正後の画像を表示
        const correctedCanvas = document.getElementById('correctedCanvas');
        correctedCanvas.width = outputSize;
        correctedCanvas.height = outputSize;
        const correctedCtx = correctedCanvas.getContext('2d');
        correctedCtx.putImageData(corrected, 0, 0);

        correctedImageData = corrected;

        // 4. カラー画像処理
        statusEl.textContent = '白背景を透明化中...';
        processColorImage(corrected);

        statusEl.className = 'status success';
        statusEl.textContent = '✓ カラーPNG変換が完了しました！';

        document.getElementById('downloadPng').disabled = false;

    } catch (error) {
        console.error(error);
        statusEl.className = 'status error';
        statusEl.textContent = `エラー: ${error.message}`;
    }
}

// カラー対応パース補正
function perspectiveTransformColor(img, srcCorners, outputSize) {
    const dstCorners = [
        { x: 0, y: 0 },
        { x: outputSize, y: 0 },
        { x: outputSize, y: outputSize },
        { x: 0, y: outputSize }
    ];

    const H = { src: srcCorners, dst: dstCorners };

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const srcImageData = ctx.getImageData(0, 0, img.width, img.height);

    const dstImageData = new ImageData(outputSize, outputSize);

    for (let y = 0; y < outputSize; y++) {
        for (let x = 0; x < outputSize; x++) {
            const srcPos = applyHomography(H, x, y, outputSize);

            if (srcPos.x >= 0 && srcPos.x < img.width - 1 && srcPos.y >= 0 && srcPos.y < img.height - 1) {
                // バイリニア補間
                const srcX = Math.floor(srcPos.x);
                const srcY = Math.floor(srcPos.y);
                const dx = srcPos.x - srcX;
                const dy = srcPos.y - srcY;

                const dstIdx = (y * outputSize + x) * 4;

                // 4つの隣接ピクセルから補間
                const idx00 = (srcY * img.width + srcX) * 4;
                const idx10 = (srcY * img.width + (srcX + 1)) * 4;
                const idx01 = ((srcY + 1) * img.width + srcX) * 4;
                const idx11 = ((srcY + 1) * img.width + (srcX + 1)) * 4;

                for (let c = 0; c < 3; c++) {
                    const v00 = srcImageData.data[idx00 + c];
                    const v10 = srcImageData.data[idx10 + c];
                    const v01 = srcImageData.data[idx01 + c];
                    const v11 = srcImageData.data[idx11 + c];

                    const value = v00 * (1 - dx) * (1 - dy) +
                                  v10 * dx * (1 - dy) +
                                  v01 * (1 - dx) * dy +
                                  v11 * dx * dy;

                    dstImageData.data[dstIdx + c] = Math.round(value);
                }
                dstImageData.data[dstIdx + 3] = 255;
            } else {
                // 範囲外は白
                const dstIdx = (y * outputSize + x) * 4;
                dstImageData.data[dstIdx] = 255;
                dstImageData.data[dstIdx + 1] = 255;
                dstImageData.data[dstIdx + 2] = 255;
                dstImageData.data[dstIdx + 3] = 255;
            }
        }
    }

    return dstImageData;
}

function applyHomography(H, x, y, maxSize) {
    const dst = H.dst;
    const src = H.src;

    const u = x / maxSize;
    const v = y / maxSize;

    const srcX = src[0].x * (1 - u) * (1 - v) +
                 src[1].x * u * (1 - v) +
                 src[2].x * u * v +
                 src[3].x * (1 - u) * v;

    const srcY = src[0].y * (1 - u) * (1 - v) +
                 src[1].y * u * (1 - v) +
                 src[2].y * u * v +
                 src[3].y * (1 - u) * v;

    return { x: srcX, y: srcY };
}

// 背景色を自動検出（四隅と端からサンプリング）
function detectBackgroundColor(imageData) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    // サンプリング位置（四隅と各辺の中央付近）
    const sampleSize = 50; // サンプリング領域のサイズ
    const samples = [];

    // 四隅からサンプリング
    const corners = [
        { x: 0, y: 0 },                           // 左上
        { x: width - sampleSize, y: 0 },          // 右上
        { x: 0, y: height - sampleSize },         // 左下
        { x: width - sampleSize, y: height - sampleSize } // 右下
    ];

    // 各辺の中央からもサンプリング
    const edges = [
        { x: width / 2 - sampleSize / 2, y: 0 },                    // 上辺中央
        { x: width / 2 - sampleSize / 2, y: height - sampleSize },  // 下辺中央
        { x: 0, y: height / 2 - sampleSize / 2 },                   // 左辺中央
        { x: width - sampleSize, y: height / 2 - sampleSize / 2 }   // 右辺中央
    ];

    const allPositions = [...corners, ...edges];

    for (const pos of allPositions) {
        const startX = Math.max(0, Math.floor(pos.x));
        const startY = Math.max(0, Math.floor(pos.y));
        const endX = Math.min(width, startX + sampleSize);
        const endY = Math.min(height, startY + sampleSize);

        for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
                const idx = (y * width + x) * 4;
                samples.push({
                    r: data[idx],
                    g: data[idx + 1],
                    b: data[idx + 2]
                });
            }
        }
    }

    // 中央値を使用（外れ値に強い）
    samples.sort((a, b) => (a.r + a.g + a.b) - (b.r + b.g + b.b));
    const medianIndex = Math.floor(samples.length / 2);

    // 中央値付近の色を平均
    const rangeStart = Math.floor(samples.length * 0.4);
    const rangeEnd = Math.floor(samples.length * 0.6);
    let sumR = 0, sumG = 0, sumB = 0;
    let count = 0;

    for (let i = rangeStart; i < rangeEnd; i++) {
        sumR += samples[i].r;
        sumG += samples[i].g;
        sumB += samples[i].b;
        count++;
    }

    const bgColor = {
        r: Math.round(sumR / count),
        g: Math.round(sumG / count),
        b: Math.round(sumB / count)
    };

    console.log(`検出された背景色: RGB(${bgColor.r}, ${bgColor.g}, ${bgColor.b})`);
    return bgColor;
}

// RGB色空間での色差を計算
function colorDistance(r1, g1, b1, r2, g2, b2) {
    // 単純なユークリッド距離
    return Math.sqrt(
        Math.pow(r1 - r2, 2) +
        Math.pow(g1 - g2, 2) +
        Math.pow(b1 - b2, 2)
    );
}

// より知覚的な色差（CIE76風の簡易版）
function perceptualColorDistance(r1, g1, b1, r2, g2, b2) {
    // 人間の目は緑に敏感なので重み付け
    const rMean = (r1 + r2) / 2;
    const dR = r1 - r2;
    const dG = g1 - g2;
    const dB = b1 - b2;

    // 赤の平均値によって重みを調整
    const rWeight = rMean < 128 ? 2 : 3;
    const gWeight = 4;
    const bWeight = rMean < 128 ? 3 : 2;

    return Math.sqrt(
        rWeight * dR * dR +
        gWeight * dG * dG +
        bWeight * dB * dB
    );
}

// HEX色をRGBに変換
function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

// 保護色リストを取得
function getProtectedColors() {
    const colors = [];
    const protectRange = parseInt(document.getElementById('protectRange').value);

    // 肌色
    if (document.getElementById('protectSkinColor').checked) {
        const skinColorHex = document.getElementById('skinColor').value;
        const skinColor = hexToRgb(skinColorHex);
        if (skinColor) {
            colors.push({ ...skinColor, range: protectRange, name: '肌色' });
        }
    }

    // カスタム色1
    if (document.getElementById('protectCustomColor1').checked) {
        const customHex = document.getElementById('customColor1').value;
        const customColor = hexToRgb(customHex);
        if (customColor) {
            colors.push({ ...customColor, range: protectRange, name: 'カスタム1' });
        }
    }

    // カスタム色2
    if (document.getElementById('protectCustomColor2').checked) {
        const customHex = document.getElementById('customColor2').value;
        const customColor = hexToRgb(customHex);
        if (customColor) {
            colors.push({ ...customColor, range: protectRange, name: 'カスタム2' });
        }
    }

    return colors;
}

// ピクセルが保護色に近いかチェック
function isProtectedColor(r, g, b, protectedColors) {
    for (const pc of protectedColors) {
        const distance = perceptualColorDistance(r, g, b, pc.r, pc.g, pc.b);
        if (distance < pc.range) {
            return true;
        }
    }
    return false;
}

// カラー画像処理（背景色を自動検出して透明化）
function processColorImage(imageData) {
    const width = imageData.width;
    const height = imageData.height;

    const colorThreshold = parseInt(document.getElementById('threshold').value);
    const edgeProtect = parseInt(document.getElementById('edgeProtect').value);

    // 1. 背景色を自動検出
    const bgColor = detectBackgroundColor(imageData);

    // 検出した背景色を表示
    const statusEl = document.getElementById('status');
    statusEl.textContent = `背景色検出: RGB(${bgColor.r}, ${bgColor.g}, ${bgColor.b}) - 処理中...`;

    // UIに背景色を表示
    const bgColorDiv = document.getElementById('detectedBgColor');
    const bgColorDisplay = document.getElementById('bgColorDisplay');
    const bgColorSwatch = document.getElementById('bgColorSwatch');
    if (bgColorDiv && bgColorDisplay && bgColorSwatch) {
        bgColorDiv.style.display = 'block';
        bgColorDisplay.textContent = `RGB(${bgColor.r}, ${bgColor.g}, ${bgColor.b})`;
        bgColorSwatch.style.backgroundColor = `rgb(${bgColor.r}, ${bgColor.g}, ${bgColor.b})`;
    }

    // 2. 保護色リストを取得
    const protectedColors = getProtectedColors();
    console.log('保護色:', protectedColors.map(c => `${c.name}: RGB(${c.r},${c.g},${c.b}) 範囲:${c.range}`));

    // 3. 黒い輪郭線（エッジ）を検出
    const edgeMap = detectEdges(imageData, edgeProtect);

    // 4. 背景との色差でマスクを作成
    const maskData = new ImageData(width, height);

    for (let i = 0; i < imageData.data.length; i += 4) {
        const r = imageData.data[i];
        const g = imageData.data[i + 1];
        const b = imageData.data[i + 2];

        // 背景色との色差を計算
        const distanceToBg = perceptualColorDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b);

        // エッジマップをチェック
        const pixelIndex = i / 4;
        const isNearEdge = edgeMap[pixelIndex] > 0;

        // 保護色かチェック
        const isProtected = isProtectedColor(r, g, b, protectedColors);

        // 背景判定：色差が閾値以下、かつエッジ付近でない、かつ保護色でない
        const isBackground = distanceToBg < colorThreshold && !isNearEdge && !isProtected;

        if (isBackground) {
            // 背景 → 透明にする部分（マスクは白）
            maskData.data[i] = 255;
            maskData.data[i + 1] = 255;
            maskData.data[i + 2] = 255;
            maskData.data[i + 3] = 255;
        } else {
            // 前景 → 保持する部分（マスクは黒）
            maskData.data[i] = 0;
            maskData.data[i + 1] = 0;
            maskData.data[i + 2] = 0;
            maskData.data[i + 3] = 255;
        }
    }

    // マスクを表示
    const maskCanvas = document.getElementById('maskCanvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.putImageData(maskData, 0, 0);

    // 4. カラーアルファ画像を生成
    const alphaData = new ImageData(width, height);

    for (let i = 0; i < imageData.data.length; i += 4) {
        const isMasked = maskData.data[i] === 255;

        if (isMasked) {
            // 背景 → 透明
            alphaData.data[i] = 0;
            alphaData.data[i + 1] = 0;
            alphaData.data[i + 2] = 0;
            alphaData.data[i + 3] = 0;
        } else {
            // 前景 → カラーを保持
            alphaData.data[i] = imageData.data[i];
            alphaData.data[i + 1] = imageData.data[i + 1];
            alphaData.data[i + 2] = imageData.data[i + 2];
            alphaData.data[i + 3] = 255;
        }
    }

    // バウンディングボックスを検出してクロップ
    const bbox = findColorBoundingBox(alphaData);

    if (bbox) {
        const croppedData = cropToSquareWithMargin(alphaData, bbox, 5);

        const alphaCanvas = document.getElementById('alphaCanvas');
        alphaCanvas.width = croppedData.width;
        alphaCanvas.height = croppedData.height;
        const alphaCtx = alphaCanvas.getContext('2d');
        alphaCtx.putImageData(croppedData, 0, 0);
    } else {
        // クロップなし
        const alphaCanvas = document.getElementById('alphaCanvas');
        alphaCanvas.width = width;
        alphaCanvas.height = height;
        const alphaCtx = alphaCanvas.getContext('2d');
        alphaCtx.putImageData(alphaData, 0, 0);
    }

    console.log('カラーアルファPNG生成完了');
    console.log(`背景色: RGB(${bgColor.r}, ${bgColor.g}, ${bgColor.b}), 色差閾値: ${colorThreshold}`);
}

// エッジ検出（Sobel風の簡易版）
function detectEdges(imageData, threshold) {
    const width = imageData.width;
    const height = imageData.height;
    const edgeMap = new Uint8Array(width * height);

    // まず暗いピクセル（輪郭線候補）を検出
    const darkThreshold = 100; // 暗いと判定する閾値

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = (y * width + x) * 4;
            const r = imageData.data[idx];
            const g = imageData.data[idx + 1];
            const b = imageData.data[idx + 2];
            const brightness = (r + g + b) / 3;

            if (brightness < darkThreshold) {
                // 暗いピクセルの周囲をマーク
                const radius = Math.ceil(threshold / 10);
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                            const dist = Math.sqrt(dx * dx + dy * dy);
                            if (dist <= radius) {
                                edgeMap[ny * width + nx] = 1;
                            }
                        }
                    }
                }
            }
        }
    }

    return edgeMap;
}

// カラー画像のバウンディングボックス検出
function findColorBoundingBox(imageData) {
    const width = imageData.width;
    const height = imageData.height;

    let minX = width, minY = height, maxX = 0, maxY = 0;
    let found = false;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const alpha = imageData.data[idx + 3];

            if (alpha > 0) {
                found = true;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    if (!found) return null;
    return { minX, minY, maxX, maxY };
}

// 正方形にクロップしてマージンを追加
function cropToSquareWithMargin(imageData, bbox, marginMm) {
    const width = imageData.width;
    const height = imageData.height;

    const bboxWidth = bbox.maxX - bbox.minX + 1;
    const bboxHeight = bbox.maxY - bbox.minY + 1;
    const maxSize = Math.max(bboxWidth, bboxHeight);

    const centerX = (bbox.minX + bbox.maxX) / 2;
    const centerY = (bbox.minY + bbox.maxY) / 2;

    const mmToPx = 4096 / 150;
    const marginPx = Math.round(marginMm * mmToPx);

    const finalSize = maxSize + marginPx * 2;

    const cropMinX = Math.max(0, Math.round(centerX - finalSize / 2));
    const cropMinY = Math.max(0, Math.round(centerY - finalSize / 2));
    const cropMaxX = Math.min(width, cropMinX + finalSize);
    const cropMaxY = Math.min(height, cropMinY + finalSize);

    const cropWidth = cropMaxX - cropMinX;
    const cropHeight = cropMaxY - cropMinY;

    const croppedData = new ImageData(cropWidth, cropHeight);

    for (let y = 0; y < cropHeight; y++) {
        for (let x = 0; x < cropWidth; x++) {
            const srcX = cropMinX + x;
            const srcY = cropMinY + y;

            if (srcX >= 0 && srcX < width && srcY >= 0 && srcY < height) {
                const srcIdx = (srcY * width + srcX) * 4;
                const dstIdx = (y * cropWidth + x) * 4;

                croppedData.data[dstIdx] = imageData.data[srcIdx];
                croppedData.data[dstIdx + 1] = imageData.data[srcIdx + 1];
                croppedData.data[dstIdx + 2] = imageData.data[srcIdx + 2];
                croppedData.data[dstIdx + 3] = imageData.data[srcIdx + 3];
            }
        }
    }

    return croppedData;
}

// 単一ファイルのダウンロード
document.getElementById('downloadPng').addEventListener('click', function() {
    downloadPng();
});

function downloadPng() {
    const canvas = document.getElementById('alphaCanvas');

    canvas.toBlob(function(blob) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;

        // ファイル名を取得
        let filename = 'color-alpha.png';
        if (selectedFiles.length > 0) {
            const originalName = selectedFiles[0].name.replace(/\.[^/.]+$/, '');
            filename = `${originalName}-color.png`;
        }

        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }, 'image/png');
}

// 一括処理
async function processAllFiles() {
    const statusEl = document.getElementById('status');
    processedResults = [];

    for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        const fileItemEl = document.getElementById(`file-${i}`);
        fileItemEl.className = 'file-item processing';

        statusEl.className = 'status loading';
        statusEl.textContent = `処理中... ${i + 1}/${selectedFiles.length}: ${file.name}`;

        try {
            // ファイルを読み込み
            const img = await loadImage(file);
            currentImage = img;

            // 処理
            processImage(img);

            // 少し待ってCanvasからBlobを取得
            await new Promise(resolve => setTimeout(resolve, 300));

            const canvas = document.getElementById('alphaCanvas');
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

            processedResults.push({
                name: file.name.replace(/\.[^/.]+$/, ''),
                blob: blob
            });

            fileItemEl.className = 'file-item done';

        } catch (error) {
            console.error(`Error processing ${file.name}:`, error);
            fileItemEl.className = 'file-item error';
            fileItemEl.title = error.message;
        }
    }

    statusEl.className = 'status success';
    statusEl.textContent = `✓ ${processedResults.length}/${selectedFiles.length}ファイルの処理が完了しました`;
    document.getElementById('downloadAllBtn').disabled = processedResults.length === 0;
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function(event) {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
            img.src = event.target.result;
        };
        reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
        reader.readAsDataURL(file);
    });
}

async function downloadAllResults() {
    if (processedResults.length === 0) {
        alert('まず処理を実行してください');
        return;
    }

    const statusEl = document.getElementById('status');
    statusEl.className = 'status loading';

    for (let i = 0; i < processedResults.length; i++) {
        const result = processedResults[i];
        const link = document.createElement('a');
        link.download = `${result.name}-color.png`;
        link.href = URL.createObjectURL(result.blob);
        link.click();

        await new Promise(resolve => setTimeout(resolve, 300));
        statusEl.textContent = `ダウンロード中... ${i + 1}/${processedResults.length}`;
    }

    statusEl.className = 'status success';
    statusEl.textContent = `✓ ${processedResults.length}個のファイルをダウンロードしました`;
}
