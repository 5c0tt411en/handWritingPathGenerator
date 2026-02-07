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

// ブラー前処理（Canvas filter利用）
function blurImage(imageData, radius) {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);

    const canvas2 = document.createElement('canvas');
    canvas2.width = imageData.width;
    canvas2.height = imageData.height;
    const ctx2 = canvas2.getContext('2d');
    ctx2.filter = `blur(${radius}px)`;
    ctx2.drawImage(canvas, 0, 0);

    return ctx2.getImageData(0, 0, canvas2.width, canvas2.height);
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

// 複数の前処理・二値化パラメータを試してマーカーを検出
// 異なる試行からの結果を統合して全4マーカーの検出を目指す
function detectMarkersWithPreprocessing(img) {
    const statusEl = document.getElementById('status');
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const originalData = ctx.getImageData(0, 0, img.width, img.height);

    // 適応二値化パラメータ（優先順）
    // kernelSize: ボックスブラーの半径（実際のウィンドウは (2k+1)×(2k+1)）
    // threshold: ローカル平均との差の閾値
    const thresholdParams = [
        { k: 2, t: 7 },     // デフォルト（5×5ウィンドウ）
        { k: 4, t: 10 },    // 中カーネル（9×9, 不均一照明に対応）
        { k: 7, t: 15 },    // 大カーネル（15×15, 強い照明ムラに対応）
        { k: 10, t: 20 },   // 特大カーネル（21×21, 角の暗い影に対応）
    ];

    // 前処理はキャッシュして必要時に計算
    let contrastData = null;
    let sharpData = null;
    let contrastSharpData = null;
    let blurData = null;
    let blurContrastData = null;

    const getContrastData = () => contrastData || (contrastData = preprocessImage(originalData));
    const getSharpData = () => sharpData || (sharpData = sharpenImage(originalData));
    const getContrastSharpData = () => contrastSharpData || (contrastSharpData = sharpenImage(getContrastData()));
    const getBlurData = () => blurData || (blurData = blurImage(originalData, 1));
    const getBlurContrastData = () => blurContrastData || (blurContrastData = preprocessImage(getBlurData()));

    const methods = [
        { name: '元画像', getData: () => originalData },
        { name: 'コントラスト強調', getData: getContrastData },
        { name: 'シャープ化', getData: getSharpData },
        { name: 'コントラスト+シャープ', getData: getContrastSharpData },
        { name: 'ブラー(1px)', getData: getBlurData },
        { name: 'ブラー+コントラスト', getData: getBlurContrastData },
    ];

    let bestResult = { markers: [], method: '' };
    let attemptLog = [];
    const validIds = new Set([0, 1, 2, 3]);

    // ユニークID数をカウント（重複マーカーを除外）
    function countUniqueValidIds(markers) {
        return new Set(markers.filter(m => validIds.has(m.id)).map(m => m.id)).size;
    }
    const bestCount = () => countUniqueValidIds(bestResult.markers);

    // 各IDの最良の検出結果を保持（異なる試行からの結果を統合）
    const bestMarkerById = {};

    function updateBestMarkers(markers, label) {
        for (const marker of markers) {
            if (!validIds.has(marker.id)) continue;
            const existing = bestMarkerById[marker.id];
            if (!existing || (marker.hammingDistance || 0) < (existing.hammingDistance || 0)) {
                bestMarkerById[marker.id] = { ...marker, _method: label };
            }
        }
    }

    function getMergedResult() {
        if ([0, 1, 2, 3].every(id => bestMarkerById[id])) {
            const mergedMarkers = [0, 1, 2, 3].map(id => bestMarkerById[id]);
            const usedMethods = [...new Set(mergedMarkers.map(m => m._method))];
            return {
                markers: mergedMarkers,
                processedData: originalData,
                log: attemptLog,
                mergedFrom: usedMethods
            };
        }
        return null;
    }

    // マーカーリストから各IDの最良結果のみを抽出（重複除去）
    function deduplicateMarkers(markers) {
        const byId = {};
        for (const marker of markers) {
            if (!validIds.has(marker.id)) continue;
            const existing = byId[marker.id];
            if (!existing || (marker.hammingDistance || 0) < (existing.hammingDistance || 0)) {
                byId[marker.id] = marker;
            }
        }
        return Object.values(byId);
    }

    // 試行を実行する共通関数
    function tryDetect(data, detectOptions, label) {
        statusEl.textContent = `検出中: ${label}...`;
        try {
            const markers = detector.detect(data, detectOptions);

            const foundValidMarkers = markers.filter(m => validIds.has(m.id));
            const uniqueIds = new Set(foundValidMarkers.map(m => m.id));
            const uniqueCount = uniqueIds.size;

            attemptLog.push(`${label}: ${uniqueCount}種のID検出 [${[...uniqueIds].sort().join(',')}]`);
            console.log(`${label}: 全${markers.length}個, ユニークID: ${uniqueCount}個 [${[...uniqueIds].sort().join(',')}]`);

            if (uniqueCount > bestCount()) {
                bestResult = { markers: markers, method: label };
            }

            updateBestMarkers(markers, label);

            // 単一試行で全4種のIDを検出
            if (uniqueCount >= 4) {
                const deduplicated = deduplicateMarkers(markers);
                console.log(`✓ ${label}で全マーカーを検出`);
                statusEl.textContent = `✓ ${label}で全マーカー検出成功`;
                return { markers: deduplicated, processedData: data, log: attemptLog };
            }

            // 統合結果で全4マーカー検出
            const merged = getMergedResult();
            if (merged) {
                console.log(`✓ 統合検出で全マーカーを検出 (${merged.mergedFrom.join(' + ')})`);
                statusEl.textContent = `✓ 統合検出で全マーカー検出成功`;
                return merged;
            }

            return null;
        } catch (e) {
            console.warn(`${label}での検出に失敗:`, e);
            attemptLog.push(`${label}: エラー`);
            return null;
        }
    }

    // Phase 1a: 適応二値化で試行（パラメータ優先: まず全前処理をデフォルトで試し、次にパラメータ変更）
    for (const params of thresholdParams) {
        for (const method of methods) {
            const label = `${method.name}(k=${params.k},t=${params.t})`;
            const result = tryDetect(method.getData(), {
                adaptiveKernelSize: params.k,
                adaptiveThreshold: params.t
            }, label);
            if (result) return result;
        }
    }

    // Phase 1b: グローバル大津二値化で試行
    // 適応二値化では検出できないマーカー（ID 0等、大きな均一黒領域を持つもの）に有効
    // 適応二値化は局所平均を使うため、広い黒領域の内部で黒ピクセルが白に誤判定される
    console.log('Phase 1b: グローバル大津二値化で試行...');
    for (const method of methods) {
        const label = `${method.name}(Otsu)`;
        const result = tryDetect(method.getData(), { useGlobalThreshold: true }, label);
        if (result) return result;
    }

    // Phase 2: ダウンスケールで再試行（高解像度画像の場合）
    if (img.width > 2000 || img.height > 2000) {
        statusEl.textContent = '高解像度画像 - ダウンスケールで再試行...';
        console.log('高解像度画像を検出 - ダウンスケールで再試行...');

        // スケール済み画像での検出を試行し、座標をスケールアップして返す共通関数
        function tryScaledDetect(data, detectOptions, label, scale) {
            try {
                const markers = detector.detect(data, detectOptions);
                markers.forEach(marker => {
                    marker.corners = marker.corners.map(corner => ({
                        x: corner.x / scale,
                        y: corner.y / scale
                    }));
                });

                const foundValidMarkers = markers.filter(m => validIds.has(m.id));
                const uniqueIds = new Set(foundValidMarkers.map(m => m.id));
                const uniqueCount = uniqueIds.size;

                attemptLog.push(`${label}: ${uniqueCount}種のID検出 [${[...uniqueIds].sort().join(',')}]`);
                console.log(`${label}: 全${markers.length}個, ユニークID: ${uniqueCount}個 [${[...uniqueIds].sort().join(',')}]`);

                if (uniqueCount > bestCount()) {
                    bestResult = { markers: markers, method: label };
                }
                updateBestMarkers(markers, label);

                if (uniqueCount >= 4) {
                    const deduplicated = deduplicateMarkers(markers);
                    return { markers: deduplicated, processedData: originalData, log: attemptLog };
                }
                return getMergedResult();
            } catch (e) {
                console.warn(`${label}での検出に失敗:`, e);
                return null;
            }
        }

        const scales = [0.5, 0.75, 0.25];
        for (const scale of scales) {
            const scaledCanvas = document.createElement('canvas');
            scaledCanvas.width = Math.round(img.width * scale);
            scaledCanvas.height = Math.round(img.height * scale);
            const scaledCtx = scaledCanvas.getContext('2d');
            scaledCtx.drawImage(img, 0, 0, scaledCanvas.width, scaledCanvas.height);
            const scaledData = scaledCtx.getImageData(0, 0, scaledCanvas.width, scaledCanvas.height);

            let scaledContrastData = null;
            const getScaledContrast = () => scaledContrastData || (scaledContrastData = preprocessImage(scaledData));

            const scaledMethods = [
                { name: `スケール${scale * 100}%`, getData: () => scaledData },
                { name: `スケール${scale * 100}%+コントラスト`, getData: getScaledContrast },
            ];

            // 適応二値化
            for (const params of thresholdParams) {
                for (const method of scaledMethods) {
                    const label = `${method.name}(k=${params.k},t=${params.t})`;
                    const result = tryScaledDetect(method.getData(), {
                        adaptiveKernelSize: params.k,
                        adaptiveThreshold: params.t
                    }, label, scale);
                    if (result) {
                        console.log(`✓ ${result.mergedFrom ? '統合検出' : label}で全マーカーを検出`);
                        statusEl.textContent = `✓ スケール${scale * 100}%で全マーカー検出成功`;
                        return result;
                    }
                }
            }

            // グローバル大津二値化
            for (const method of scaledMethods) {
                const label = `${method.name}(Otsu)`;
                const result = tryScaledDetect(method.getData(), { useGlobalThreshold: true }, label, scale);
                if (result) {
                    console.log(`✓ ${result.mergedFrom ? '統合検出' : label}で全マーカーを検出`);
                    statusEl.textContent = `✓ スケール${scale * 100}%+Otsuで全マーカー検出成功`;
                    return result;
                }
            }
        }
    }

    // Phase 3: コーナー領域を切り出して個別検出
    // 画像全体では検出できないマーカーも、コーナー領域だけで処理すると
    // 二値化が局所的に適用されるため検出できることがある
    const missingIds = [0, 1, 2, 3].filter(id => !bestMarkerById[id]);
    if (missingIds.length > 0 && missingIds.length < 4) {
        console.log(`Phase 3: コーナー検出 - 未検出ID: ${missingIds.join(',')}`);
        statusEl.textContent = `コーナー領域で未検出マーカーを検索中...`;

        const cornerSize = Math.round(Math.min(img.width, img.height) * 0.35);
        // ID→コーナー位置のマッピング（ID 0=左上, 1=右上, 2=右下, 3=左下）
        const cornerPositions = [
            { id: 0, name: '左上', x: 0, y: 0 },
            { id: 1, name: '右上', x: img.width - cornerSize, y: 0 },
            { id: 2, name: '右下', x: img.width - cornerSize, y: img.height - cornerSize },
            { id: 3, name: '左下', x: 0, y: img.height - cornerSize },
        ];

        // コーナー検出の試行共通関数
        function tryCornerDetect(cornerData, detectOptions, label, corner) {
            try {
                const markers = detector.detect(cornerData, detectOptions);

                // 座標をフル画像の座標系に変換
                markers.forEach(marker => {
                    marker.corners = marker.corners.map(c => ({
                        x: c.x + corner.x,
                        y: c.y + corner.y
                    }));
                });

                const foundTarget = markers.filter(m => m.id === corner.id);
                if (foundTarget.length > 0) {
                    attemptLog.push(`${label}: ID ${corner.id}を検出!`);
                    console.log(`✓ ${label}でID ${corner.id}を検出`);
                    updateBestMarkers(markers, label);
                    return true; // 発見
                }
                return false;
            } catch (e) {
                return false;
            }
        }

        for (const corner of cornerPositions) {
            if (bestMarkerById[corner.id]) continue; // すでに検出済み

            const cornerCanvas = document.createElement('canvas');
            cornerCanvas.width = cornerSize;
            cornerCanvas.height = cornerSize;
            const cornerCtx = cornerCanvas.getContext('2d');
            cornerCtx.drawImage(img, corner.x, corner.y, cornerSize, cornerSize, 0, 0, cornerSize, cornerSize);
            const cornerData = cornerCtx.getImageData(0, 0, cornerSize, cornerSize);

            // コーナー画像に前処理を適用
            const cornerMethods = [
                { name: `コーナー${corner.name}`, data: cornerData },
                { name: `コーナー${corner.name}+コントラスト`, data: preprocessImage(cornerData) },
                { name: `コーナー${corner.name}+ブラー+コントラスト`, data: preprocessImage(blurImage(cornerData, 1)) },
            ];

            // 適応二値化で試行
            let found = false;
            for (const params of thresholdParams) {
                for (const method of cornerMethods) {
                    const label = `${method.name}(k=${params.k},t=${params.t})`;
                    if (tryCornerDetect(method.data, {
                        adaptiveKernelSize: params.k,
                        adaptiveThreshold: params.t
                    }, label, corner)) {
                        found = true;
                        break;
                    }
                }
                if (found) break;
            }

            // グローバル大津二値化で試行
            if (!found) {
                for (const method of cornerMethods) {
                    const label = `${method.name}(Otsu)`;
                    if (tryCornerDetect(method.data, { useGlobalThreshold: true }, label, corner)) {
                        found = true;
                        break;
                    }
                }
            }

            // 統合結果チェック
            const merged = getMergedResult();
            if (merged) {
                console.log(`✓ 統合検出で全マーカーを検出 (${merged.mergedFrom.join(' + ')})`);
                statusEl.textContent = `✓ 統合検出で全マーカー検出成功`;
                return merged;
            }
        }

        // Phase 3 後の最終統合チェック
        const merged = getMergedResult();
        if (merged) {
            console.log(`✓ コーナー検出後の統合で全マーカーを検出`);
            statusEl.textContent = `✓ 統合検出で全マーカー検出成功`;
            return merged;
        }
    }

    const foundSummary = Object.keys(bestMarkerById).map(Number).sort().join(',');
    console.log(`最良の結果: ${bestResult.method} (${bestResult.markers.length}個), 統合検出ID: [${foundSummary}]`);
    console.log('検出試行ログ:', attemptLog);
    return { markers: bestResult.markers, processedData: originalData, log: attemptLog };
}

function handleFiles(files) {
    // 画像ファイルのみフィルタリング
    const imageExtensions = /\.(jpe?g|png|gif|bmp|webp|tiff?)$/i;
    selectedFiles = Array.from(files).filter(f => imageExtensions.test(f.name));
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
}

document.getElementById('imageInput').addEventListener('change', function(e) {
    handleFiles(e.target.files);
});

document.getElementById('folderInput').addEventListener('change', function(e) {
    handleFiles(e.target.files);
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
        const insetPx = -insetMm * mmToPx;

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

// 分離可能ダイレーション（膨張）
function dilateArray(arr, width, height, radius) {
    const total = width * height;
    const dilatedH = new Uint8Array(total);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        let last = -radius - 1;
        for (let x = 0; x < width; x++) {
            if (arr[row + x]) last = x;
            if (x - last <= radius) dilatedH[row + x] = 1;
        }
        last = width + radius + 1;
        for (let x = width - 1; x >= 0; x--) {
            if (arr[row + x]) last = x;
            if (last - x <= radius) dilatedH[row + x] = 1;
        }
    }
    const dilated = new Uint8Array(total);
    for (let x = 0; x < width; x++) {
        let last = -radius - 1;
        for (let y = 0; y < height; y++) {
            if (dilatedH[y * width + x]) last = y;
            if (y - last <= radius) dilated[y * width + x] = 1;
        }
        last = height + radius + 1;
        for (let y = height - 1; y >= 0; y--) {
            if (dilatedH[y * width + x]) last = y;
            if (last - y <= radius) dilated[y * width + x] = 1;
        }
    }
    return dilated;
}

// 背景ノイズ除去（前景マスクにモルフォロジカルオープニングを適用）
// 小さな前景スペック（ノイズ）を収縮で消し、膨張で本来の前景を復元
function denoiseBackground(maskData, width, height, radius) {
    if (radius <= 0) return;
    const total = width * height;

    // 前景フラグ抽出 (1=前景/黒, 0=背景/白)
    const fg = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
        fg[i] = maskData.data[i * 4] === 0 ? 1 : 0;
    }

    // オープニング: 収縮 → 膨張
    const eroded = erodeArray(fg, width, height, radius);
    const opened = dilateArray(eroded, width, height, radius);

    // マスクに書き戻し
    for (let i = 0; i < total; i++) {
        const val = opened[i] ? 0 : 255;
        maskData.data[i * 4] = val;
        maskData.data[i * 4 + 1] = val;
        maskData.data[i * 4 + 2] = val;
    }

    const removed = fg.reduce((s, v) => s + v, 0) - opened.reduce((s, v) => s + v, 0);
    console.log(`ノイズ除去: ${removed}ピクセルの前景ノイズを除去 (半径${radius}px)`);
}

// Uint8Array上でBFS: 画像の縁から passable=1 のピクセルを通って到達可能な領域を検出
function floodFillFromBorder(passable, width, height) {
    const total = width * height;
    const result = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0, tail = 0;

    // 画像の縁にある通過可能ピクセルをシードとして追加
    for (let x = 0; x < width; x++) {
        if (passable[x] && !result[x]) {
            result[x] = 1; queue[tail++] = x;
        }
        const b = (height - 1) * width + x;
        if (passable[b] && !result[b]) {
            result[b] = 1; queue[tail++] = b;
        }
    }
    for (let y = 1; y < height - 1; y++) {
        const l = y * width;
        if (passable[l] && !result[l]) {
            result[l] = 1; queue[tail++] = l;
        }
        const r = y * width + (width - 1);
        if (passable[r] && !result[r]) {
            result[r] = 1; queue[tail++] = r;
        }
    }

    while (head < tail) {
        const idx = queue[head++];
        const x = idx % width;
        const y = (idx - x) / width;
        if (x > 0)          { const n = idx - 1;     if (passable[n] && !result[n]) { result[n] = 1; queue[tail++] = n; } }
        if (x < width - 1)  { const n = idx + 1;     if (passable[n] && !result[n]) { result[n] = 1; queue[tail++] = n; } }
        if (y > 0)          { const n = idx - width;  if (passable[n] && !result[n]) { result[n] = 1; queue[tail++] = n; } }
        if (y < height - 1) { const n = idx + width;  if (passable[n] && !result[n]) { result[n] = 1; queue[tail++] = n; } }
    }

    return result;
}

// 分離可能エロージョン（収縮）: 非対象ピクセルから距離 radius 以内の対象ピクセルを除去
function erodeArray(arr, width, height, radius) {
    const total = width * height;

    // 水平エロージョン
    const erodedH = new Uint8Array(total);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        // 左→右: 最後の非対象ピクセル位置を追跡
        let lastZero = -radius - 1;
        for (let x = 0; x < width; x++) {
            if (!arr[row + x]) lastZero = x;
            if (x - lastZero > radius) erodedH[row + x] = 1;
        }
        // 右→左: 両方向で生存したピクセルのみ残す
        lastZero = width + radius;
        for (let x = width - 1; x >= 0; x--) {
            if (!arr[row + x]) lastZero = x;
            if (!(lastZero - x > radius)) erodedH[row + x] = 0;
        }
    }

    // 垂直エロージョン
    const eroded = new Uint8Array(total);
    for (let x = 0; x < width; x++) {
        let lastZero = -radius - 1;
        for (let y = 0; y < height; y++) {
            if (!erodedH[y * width + x]) lastZero = y;
            if (y - lastZero > radius) eroded[y * width + x] = 1;
        }
        lastZero = height + radius;
        for (let y = height - 1; y >= 0; y--) {
            if (!erodedH[y * width + x]) lastZero = y;
            if (!(lastZero - y > radius)) eroded[y * width + x] = 0;
        }
    }

    return eroded;
}

// 外部背景を検出（ギャップを閉じる処理付き）
// 1. フラッドフィルで初期外部を検出
// 2. 外部をエロージョンして細い漏れ（ギャップ経由の侵入）を断ち切る
// 3. 縁からエロージョン済み外部を通って再フラッドフィル → 漏れた内部は到達不可に
function findExteriorPixels(maskData, width, height, gapCloseRadius) {
    const total = width * height;

    // 背景マスクを抽出 (1=背景, 0=前景)
    const isBackground = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
        isBackground[i] = maskData.data[i * 4] === 255 ? 1 : 0;
    }

    // Step 1: 縁から背景を通ってフラッドフィル → 初期外部
    const initialExterior = floodFillFromBorder(isBackground, width, height);

    if (gapCloseRadius <= 0) {
        console.log('ギャップ閉じ無効 - 初期外部をそのまま使用');
        return initialExterior;
    }

    // Step 2: 外部をエロージョン → 細い通路（ギャップからの漏れ）を除去
    const erodedExterior = erodeArray(initialExterior, width, height, gapCloseRadius);

    // Step 3: 縁からエロージョン済み外部を通って再フラッドフィル
    // → ギャップ経由で漏れた内部領域には到達できない
    const finalExterior = floodFillFromBorder(erodedExterior, width, height);

    // Step 4: 最終外部をダイレーションして、エロージョンで縮んだ外部縁を復元
    // （外部の端が白になるのを防ぐ）
    const restoredExterior = dilateToOriginal(finalExterior, isBackground, width, height, gapCloseRadius);

    const extCount = restoredExterior.reduce((s, v) => s + v, 0);
    console.log(`外部背景ピクセル: ${extCount}/${total} (${(extCount / total * 100).toFixed(1)}%), ギャップ閉じ半径: ${gapCloseRadius}px`);
    return restoredExterior;
}

// エロージョンで縮んだ外部を元の背景範囲内でダイレーションして復元
function dilateToOriginal(exterior, isBackground, width, height, radius) {
    const total = width * height;

    // 水平ダイレーション
    const dilatedH = new Uint8Array(total);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        let lastExt = -radius - 1;
        for (let x = 0; x < width; x++) {
            if (exterior[row + x]) lastExt = x;
            if (x - lastExt <= radius && isBackground[row + x]) dilatedH[row + x] = 1;
        }
        lastExt = width + radius + 1;
        for (let x = width - 1; x >= 0; x--) {
            if (exterior[row + x]) lastExt = x;
            if (lastExt - x <= radius && isBackground[row + x]) dilatedH[row + x] = 1;
        }
    }

    // 垂直ダイレーション
    const dilated = new Uint8Array(total);
    for (let x = 0; x < width; x++) {
        let lastExt = -radius - 1;
        for (let y = 0; y < height; y++) {
            if (dilatedH[y * width + x]) lastExt = y;
            if (y - lastExt <= radius && isBackground[y * width + x]) dilated[y * width + x] = 1;
        }
        lastExt = height + radius + 1;
        for (let y = height - 1; y >= 0; y--) {
            if (dilatedH[y * width + x]) lastExt = y;
            if (lastExt - y <= radius && isBackground[y * width + x]) dilated[y * width + x] = 1;
        }
    }

    return dilated;
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

    // 背景ノイズ除去
    const denoiseRadius = parseInt(document.getElementById('denoiseRadius').value);
    denoiseBackground(maskData, width, height, denoiseRadius);

    // マスクを表示
    const maskCanvas = document.getElementById('maskCanvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.putImageData(maskData, 0, 0);

    // 4. 外部背景を検出（ギャップ閉じ処理付き）
    const gapCloseRadius = parseInt(document.getElementById('gapCloseRadius').value);
    const isExterior = findExteriorPixels(maskData, width, height, gapCloseRadius);

    // 5. カラーアルファ画像を生成
    const alphaData = new ImageData(width, height);

    for (let i = 0; i < imageData.data.length; i += 4) {
        const pixelIndex = i / 4;
        const isMasked = maskData.data[i] === 255;

        if (isMasked && isExterior[pixelIndex]) {
            // 外部背景 → 透明
            alphaData.data[i] = 0;
            alphaData.data[i + 1] = 0;
            alphaData.data[i + 2] = 0;
            alphaData.data[i + 3] = 0;
        } else if (isMasked && !isExterior[pixelIndex]) {
            // 内部背景（閉じた領域内） → 白
            alphaData.data[i] = 255;
            alphaData.data[i + 1] = 255;
            alphaData.data[i + 2] = 255;
            alphaData.data[i + 3] = 255;
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
        let filename = 'Alpha_image.png';
        if (selectedFiles.length > 0) {
            const originalName = selectedFiles[0].name.replace(/\.[^/.]+$/, '');
            filename = `Alpha_${originalName}.png`;
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
    statusEl.textContent = 'ZIPファイルを作成中...';

    const zip = new JSZip();

    for (let i = 0; i < processedResults.length; i++) {
        const result = processedResults[i];
        zip.file(`Alpha_${result.name}.png`, result.blob);
        statusEl.textContent = `ZIPに追加中... ${i + 1}/${processedResults.length}`;
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' }, function(metadata) {
        statusEl.textContent = `ZIP生成中... ${Math.round(metadata.percent)}%`;
    });

    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Alpha_images.zip';
    link.click();
    URL.revokeObjectURL(url);

    statusEl.className = 'status success';
    statusEl.textContent = `✓ ${processedResults.length}個のファイルをZIPでダウンロードしました`;
}
