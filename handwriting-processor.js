let detector;
let currentImage = null;
let correctedImageData = null;

// ページ読み込み後にディテクタを初期化
window.addEventListener('load', function() {
    if (typeof AR !== 'undefined') {
        detector = new AR.Detector({ dictionaryName: 'ARUCO' });
        console.log('ArUco detector initialized');
    }
});

document.getElementById('imageInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(event) {
            const img = new Image();
            img.onload = function() {
                currentImage = img;
                processImage(img);
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    }
});

function reprocess() {
    if (currentImage) {
        // 画像全体を再処理（余白の変更も反映）
        processImage(currentImage);
    } else if (correctedImageData) {
        // 画像がない場合は二値化のみ再処理
        binarizeAndTracePath(correctedImageData);
    }
}

function processImage(img) {
    const statusEl = document.getElementById('status');
    statusEl.className = 'status loading';
    statusEl.textContent = 'ARマーカーを検出中...';

    try {
        // 1. 元画像を表示してマーカー検出
        const originalCanvas = document.getElementById('originalCanvas');
        const ctx = originalCanvas.getContext('2d');
        originalCanvas.width = img.width;
        originalCanvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        const markers = detector.detect(imageData);

        console.log(`検出されたマーカー数: ${markers.length}`);

        if (markers.length < 4) {
            throw new Error(`ARマーカーが${markers.length}個しか検出されませんでした。4個必要です。`);
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

        // ID 0-3のマーカーを探す
        const markerMap = {};
        markers.forEach(marker => {
            if (marker.id >= 0 && marker.id <= 3) {
                markerMap[marker.id] = marker;
            }
        });

        if (Object.keys(markerMap).length < 4) {
            throw new Error('ID 0-3のマーカーが全て検出されませんでした');
        }

        // 内側への余白（ピクセル）を取得
        const insetMm = parseFloat(document.getElementById('insetMargin').value);
        // マーカーサイズから余白のピクセル値を推定
        // テンプレートのマーカーサイズは通常20mmで、画像解像度に依存
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

        // テンプレートのマーカーサイズが20mmと仮定してmm→px変換率を計算
        const templateMarkerSizeMm = 20;
        const mmToPx = markerSizePx / templateMarkerSizeMm;
        const insetPx = insetMm * mmToPx;

        console.log(`マーカーサイズ: ${markerSizePx.toFixed(1)}px, 余白: ${insetMm}mm = ${insetPx.toFixed(1)}px`);

        // 各マーカーの内側の角を取得
        // マーカー配置: 0=左上, 1=右上, 2=右下, 3=左下
        // 各マーカーの corners は時計回りに [左上, 右上, 右下, 左下]

        const drawingAreaCorners = [
            // ID 0 (左上マーカー) の右下角 + 余白
            {
                x: markerMap[0].corners[2].x + insetPx,
                y: markerMap[0].corners[2].y + insetPx
            },
            // ID 1 (右上マーカー) の左下角 + 余白
            {
                x: markerMap[1].corners[3].x - insetPx,
                y: markerMap[1].corners[3].y + insetPx
            },
            // ID 2 (右下マーカー) の左上角 + 余白
            {
                x: markerMap[2].corners[0].x - insetPx,
                y: markerMap[2].corners[0].y - insetPx
            },
            // ID 3 (左下マーカー) の右上角 + 余白
            {
                x: markerMap[3].corners[1].x + insetPx,
                y: markerMap[3].corners[1].y - insetPx
            }
        ];

        // 描画エリアの四角形を表示
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(drawingAreaCorners[0].x, drawingAreaCorners[0].y);
        for (let i = 1; i < drawingAreaCorners.length; i++) {
            ctx.lineTo(drawingAreaCorners[i].x, drawingAreaCorners[i].y);
        }
        ctx.closePath();
        ctx.stroke();

        // 3. パース補正（ホモグラフィ変換）
        const outputSize = 4096; // 出力画像のサイズ
        const corrected = perspectiveTransform(
            img,
            drawingAreaCorners,
            outputSize
        );

        // 補正後の画像を表示
        const correctedCanvas = document.getElementById('correctedCanvas');
        correctedCanvas.width = outputSize;
        correctedCanvas.height = outputSize;
        const correctedCtx = correctedCanvas.getContext('2d');
        correctedCtx.putImageData(corrected, 0, 0);

        correctedImageData = corrected;

        // 4. 二値化とパストレース
        statusEl.textContent = '画像を二値化してパストレース中...';
        binarizeAndTracePath(corrected);

        statusEl.className = 'status success';
        statusEl.textContent = '✓ SVG変換が完了しました！';

        document.getElementById('downloadSvg').disabled = false;
        document.getElementById('downloadPng').disabled = false;
        document.getElementById('copySvg').disabled = false;

    } catch (error) {
        console.error(error);
        statusEl.className = 'status error';
        statusEl.textContent = `エラー: ${error.message}`;
    }
}

// パース補正（ホモグラフィ変換）
function perspectiveTransform(img, srcCorners, outputSize) {
    // 出力先の4隅（正方形）
    const dstCorners = [
        { x: 0, y: 0 },                    // 左上
        { x: outputSize, y: 0 },           // 右上
        { x: outputSize, y: outputSize },  // 右下
        { x: 0, y: outputSize }            // 左下
    ];

    // ホモグラフィ行列を計算
    const H = getHomographyMatrix(srcCorners, dstCorners);

    // 変換を適用
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const srcImageData = ctx.getImageData(0, 0, img.width, img.height);

    const dstImageData = new ImageData(outputSize, outputSize);

    for (let y = 0; y < outputSize; y++) {
        for (let x = 0; x < outputSize; x++) {
            // 逆変換で元画像の座標を求める
            const srcPos = applyHomography(H, x, y, true);

            if (srcPos.x >= 0 && srcPos.x < img.width && srcPos.y >= 0 && srcPos.y < img.height) {
                // バイリニア補間
                const srcX = Math.floor(srcPos.x);
                const srcY = Math.floor(srcPos.y);
                const dx = srcPos.x - srcX;
                const dy = srcPos.y - srcY;

                const srcIdx = (srcY * img.width + srcX) * 4;
                const dstIdx = (y * outputSize + x) * 4;

                // 簡易的に最近傍補間
                if (srcIdx >= 0 && srcIdx < srcImageData.data.length - 4) {
                    dstImageData.data[dstIdx] = srcImageData.data[srcIdx];
                    dstImageData.data[dstIdx + 1] = srcImageData.data[srcIdx + 1];
                    dstImageData.data[dstIdx + 2] = srcImageData.data[srcIdx + 2];
                    dstImageData.data[dstIdx + 3] = 255;
                }
            }
        }
    }

    return dstImageData;
}

// ホモグラフィ行列計算（簡略版）
function getHomographyMatrix(src, dst) {
    // 4点対応からホモグラフィ行列を計算
    // 実装を簡略化：アフィン変換で近似
    // 正確には8自由度の射影変換が必要だが、ここでは簡易的に実装

    // 逆行列を返す（dst→src変換用）
    return {
        src: src,
        dst: dst
    };
}

// ホモグラフィ適用（簡易版：バイリニア補間）
function applyHomography(H, x, y, inverse) {
    // 簡易的な実装：4点から双線形補間
    const dst = H.dst;
    const src = H.src;

    // 正規化座標（0-1）
    const maxX = Math.max(...dst.map(p => p.x));
    const maxY = Math.max(...dst.map(p => p.y));
    const u = x / maxX;
    const v = y / maxY;

    // 双線形補間
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

// ノイズ除去（小さな連結成分を削除）
function removeSmallNoise(binaryData) {
    const width = binaryData.width;
    const height = binaryData.height;

    // 連結成分のサイズ閾値（ピクセル数）
    // 4096x4096の解像度で、約0.5mm x 0.5mm以下の点を除去
    // 4096px / 150mm ≈ 27.31 px/mm なので、0.5mm ≈ 14px
    // 14px x 14px = 196ピクセル程度を閾値とする
    const minComponentSize = 200;

    const labels = new Int32Array(width * height);
    let labelCount = 0;
    const componentSizes = new Map();

    // 8方向の隣接ピクセル
    const dx = [-1, 0, 1, -1, 1, -1, 0, 1];
    const dy = [-1, -1, -1, 0, 0, 1, 1, 1];

    // Flood fillで連結成分をラベリング
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const pixelIdx = idx * 4;
            const isBlack = binaryData.data[pixelIdx] === 0;

            if (isBlack && labels[idx] === 0) {
                labelCount++;
                let size = 0;
                const stack = [{x, y}];

                while (stack.length > 0) {
                    const pos = stack.pop();
                    const px = pos.x;
                    const py = pos.y;

                    if (px < 0 || px >= width || py < 0 || py >= height) continue;

                    const pIdx = py * width + px;
                    const pPixelIdx = pIdx * 4;

                    if (labels[pIdx] !== 0 || binaryData.data[pPixelIdx] !== 0) continue;

                    labels[pIdx] = labelCount;
                    size++;

                    // 8近傍を探索
                    for (let i = 0; i < 8; i++) {
                        stack.push({x: px + dx[i], y: py + dy[i]});
                    }
                }

                componentSizes.set(labelCount, size);
            }
        }
    }

    console.log(`連結成分数: ${labelCount}`);

    // 小さな成分を白に変換
    let removedCount = 0;
    for (let i = 0; i < labels.length; i++) {
        const label = labels[i];
        if (label > 0) {
            const size = componentSizes.get(label);
            if (size < minComponentSize) {
                const pixelIdx = i * 4;
                binaryData.data[pixelIdx] = 255;
                binaryData.data[pixelIdx + 1] = 255;
                binaryData.data[pixelIdx + 2] = 255;
                removedCount++;
            }
        }
    }

    console.log(`ノイズ除去: ${removedCount}ピクセルを削除`);
}

// 二値化とパストレース
function binarizeAndTracePath(imageData) {
    const statusEl = document.getElementById('status');
    statusEl.className = 'status loading';
    statusEl.textContent = '二値化処理中...';

    const threshold = parseInt(document.getElementById('threshold').value);
    const invert = document.getElementById('invertColors').checked;

    const width = imageData.width;
    const height = imageData.height;

    // 二値化
    const binaryData = new ImageData(width, height);
    for (let i = 0; i < imageData.data.length; i += 4) {
        const r = imageData.data[i];
        const g = imageData.data[i + 1];
        const b = imageData.data[i + 2];
        const gray = (r + g + b) / 3;

        let isBlack = gray < threshold;
        if (invert) isBlack = !isBlack;

        const value = isBlack ? 0 : 255;
        binaryData.data[i] = value;
        binaryData.data[i + 1] = value;
        binaryData.data[i + 2] = value;
        binaryData.data[i + 3] = 255;
    }

    // ノイズ除去
    statusEl.textContent = 'ノイズ除去中...';
    removeSmallNoise(binaryData);

    // 二値化画像を表示
    const binaryCanvas = document.getElementById('binaryCanvas');
    binaryCanvas.width = width;
    binaryCanvas.height = height;
    const binaryCtx = binaryCanvas.getContext('2d');
    binaryCtx.putImageData(binaryData, 0, 0);

    // アルファ付きPNGを生成
    statusEl.className = 'status loading';
    statusEl.textContent = 'アルファ付きPNGを生成中...';

    setTimeout(() => {
        try {
            generateAlphaPNG(binaryData);
            statusEl.className = 'status success';
            statusEl.textContent = '✓ PNG変換が完了しました！';
        } catch (error) {
            console.error('PNG生成エラー:', error);
            statusEl.className = 'status error';
            statusEl.textContent = `エラー: ${error.message}`;
        }
    }, 100);
}

// アルファ付きPNG生成
function generateAlphaPNG(binaryData) {
    const width = binaryData.width;
    const height = binaryData.height;

    // アルファチャンネル付きの画像データを作成
    const alphaImageData = new ImageData(width, height);

    for (let i = 0; i < binaryData.data.length; i += 4) {
        const isBlack = binaryData.data[i] === 0;

        if (isBlack) {
            // 黒い部分 → 黒色、不透明
            alphaImageData.data[i] = 0;       // R
            alphaImageData.data[i + 1] = 0;   // G
            alphaImageData.data[i + 2] = 0;   // B
            alphaImageData.data[i + 3] = 255; // A (不透明)
        } else {
            // 白い部分 → 透明
            alphaImageData.data[i] = 0;       // R
            alphaImageData.data[i + 1] = 0;   // G
            alphaImageData.data[i + 2] = 0;   // B
            alphaImageData.data[i + 3] = 0;   // A (透明)
        }
    }

    // バウンディングボックスを検出
    const bbox = findBoundingBox(binaryData);
    console.log('バウンディングボックス:', bbox);

    if (!bbox) {
        console.warn('黒いピクセルが見つかりませんでした');
        // 全体を表示
        const canvas = document.getElementById('alphaCanvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(alphaImageData, 0, 0);
        document.getElementById('downloadPng').disabled = false;
        return;
    }

    // 正方形に拡張 + 5mmの余白を追加
    const croppedImageData = cropToSquareWithMargin(alphaImageData, bbox, 5);

    // キャンバスに描画
    const canvas = document.getElementById('alphaCanvas');
    canvas.width = croppedImageData.width;
    canvas.height = croppedImageData.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(croppedImageData, 0, 0);

    // ダウンロードボタンを有効化
    document.getElementById('downloadPng').disabled = false;

    console.log(`アルファ付きPNG生成完了: ${croppedImageData.width}x${croppedImageData.height}px`);
}

// バウンディングボックスを検出（黒いピクセルの範囲）
function findBoundingBox(imageData) {
    const width = imageData.width;
    const height = imageData.height;

    let minX = width, minY = height, maxX = 0, maxY = 0;
    let found = false;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const isBlack = imageData.data[idx] === 0;

            if (isBlack) {
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

// 正方形に拡張してマージンを追加してトリミング
function cropToSquareWithMargin(imageData, bbox, marginMm) {
    const width = imageData.width;
    const height = imageData.height;

    // バウンディングボックスのサイズ
    const bboxWidth = bbox.maxX - bbox.minX + 1;
    const bboxHeight = bbox.maxY - bbox.minY + 1;

    // 正方形にするため、大きい方に合わせる
    const maxSize = Math.max(bboxWidth, bboxHeight);

    // 中心を計算
    const centerX = (bbox.minX + bbox.maxX) / 2;
    const centerY = (bbox.minY + bbox.maxY) / 2;

    // mmをピクセルに変換（元画像が4096pxで150mmと仮定）
    const mmToPx = 4096 / 150; // 約27.31 px/mm
    const marginPx = Math.round(marginMm * mmToPx);

    // 正方形 + マージンのサイズ
    const finalSize = maxSize + marginPx * 2;

    // トリミング範囲を計算（中心からの正方形）
    const cropMinX = Math.max(0, Math.round(centerX - finalSize / 2));
    const cropMinY = Math.max(0, Math.round(centerY - finalSize / 2));
    const cropMaxX = Math.min(width, cropMinX + finalSize);
    const cropMaxY = Math.min(height, cropMinY + finalSize);

    const cropWidth = cropMaxX - cropMinX;
    const cropHeight = cropMaxY - cropMinY;

    console.log(`トリミング: ${cropWidth}x${cropHeight}px (余白: ${marginMm}mm = ${marginPx}px)`);

    // 新しい画像データを作成
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

// 旧SVG生成関数（削除予定）
function generateSVG_old(binaryData) {
    const width = binaryData.width;
    const height = binaryData.height;

    const svg = document.getElementById('svgOutput');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    console.log('輪郭を抽出中...');

    // 輪郭抽出
    const contours = traceContours(binaryData);
    console.log(`${contours.length}個の輪郭を検出`);

    if (contours.length === 0) {
        console.warn('輪郭が検出されませんでした');
        svg.innerHTML = '';
        return false;
    }

    // 輪郭を分類（面積の符号で外側/内側を判定）
    const processedContours = contours.map((contour, index) => {
        if (contour.length < 10) {
            return null;
        }

        const signedArea = calculateSignedArea(contour);
        const area = Math.abs(signedArea);
        const perimeter = contour.length;
        const avgWidth = (area / perimeter) * 2;

        console.log(`輪郭${index}: 面積=${area.toFixed(0)}, 符号付き面積=${signedArea.toFixed(0)}, 周長=${perimeter.toFixed(0)}, 推定幅=${avgWidth.toFixed(1)}px`);

        return {
            contour: contour,
            area: area,
            signedArea: signedArea,
            avgWidth: avgWidth,
            isOuter: signedArea > 0  // 正=外側（時計回り）、負=内側（反時計回り）
        };
    }).filter(c => c !== null);

    // 面積でソート（大きい順）
    processedContours.sort((a, b) => b.area - a.area);

    console.log(`処理対象: ${processedContours.length}個`);

    // グループ化: 外側の輪郭とその内側の穴をまとめる
    const groups = [];
    processedContours.forEach((item, index) => {
        if (item.isOuter) {
            // 外側の輪郭 → 新しいグループを作成
            groups.push({
                outer: item,
                holes: [],
                avgWidth: item.avgWidth
            });
        } else {
            // 内側の輪郭（穴）→ 最も近い外側の輪郭に追加
            // 簡易的に最初のグループに追加
            if (groups.length > 0) {
                groups[groups.length - 1].holes.push(item);
            }
        }
    });

    console.log(`グループ数: ${groups.length}`);

    // SVGを生成
    let svgContent = '';

    groups.forEach((group, gindex) => {
        // 簡略化の許容誤差を自動調整（線の幅に応じて）
        const tolerance = Math.max(0.5, Math.min(2.0, group.avgWidth * 0.3));

        // 外側の輪郭を滑らかに
        const outerSmoothed = smoothContour(group.outer.contour, tolerance);

        if (outerSmoothed.length < 3) {
            console.log(`グループ${gindex}: スキップ（点数不足）`);
            return;
        }

        // fill-rule="evenodd"で穴を表現
        let combinedPath = contourToClosedPath(outerSmoothed);

        // 穴を追加
        group.holes.forEach((hole, hindex) => {
            const holeTolerance = Math.max(0.5, Math.min(2.0, hole.avgWidth * 0.3));
            const holeSmoothed = smoothContour(hole.contour, holeTolerance);
            if (holeSmoothed.length >= 3) {
                combinedPath += ' ' + contourToClosedPath(holeSmoothed);
                console.log(`  穴${hindex}: 追加（${holeSmoothed.length}点）`);
            }
        });

        svgContent += `<path d="${combinedPath}" fill="black" fill-rule="evenodd" stroke="none"/>\n`;
        console.log(`グループ${gindex}: パス生成成功（外側${outerSmoothed.length}点、穴${group.holes.length}個、許容誤差=${tolerance.toFixed(2)}）`);
    });

    if (svgContent) {
        svg.innerHTML = svgContent;
        return true;
    } else {
        console.warn('パスが生成されませんでした');
        svg.innerHTML = '';
        return false;
    }
}

// 面積計算（絶対値）
function calculateArea(contour) {
    return Math.abs(calculateSignedArea(contour));
}

// 符号付き面積計算（時計回りか反時計回りか判定）
function calculateSignedArea(contour) {
    let area = 0;
    for (let i = 0; i < contour.length; i++) {
        const j = (i + 1) % contour.length;
        area += contour[i].x * contour[j].y;
        area -= contour[j].x * contour[i].y;
    }
    return area / 2;
}

// 輪郭を閉じたパスに変換（滑らかなベジェ曲線）
function contourToClosedPath(contour) {
    if (contour.length < 3) return '';

    const points = contour;
    let path = `M ${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;

    if (points.length === 3) {
        // 3点の場合は2次ベジェ曲線
        const midX = (points[0].x + points[1].x + points[2].x) / 3;
        const midY = (points[0].y + points[1].y + points[2].y) / 3;
        path += ` Q ${points[1].x.toFixed(2)},${points[1].y.toFixed(2)} ${points[2].x.toFixed(2)},${points[2].y.toFixed(2)}`;
    } else if (points.length === 4) {
        // 4点の場合
        path += ` C ${points[1].x.toFixed(2)},${points[1].y.toFixed(2)} ${points[2].x.toFixed(2)},${points[2].y.toFixed(2)} ${points[3].x.toFixed(2)},${points[3].y.toFixed(2)}`;
    } else {
        // 5点以上の場合は滑らかなCatmull-Romスプライン
        const tension = 0.4; // 張力（高いほど角が丸くなる）

        for (let i = 0; i < points.length; i++) {
            const p0 = points[(i - 1 + points.length) % points.length];
            const p1 = points[i];
            const p2 = points[(i + 1) % points.length];
            const p3 = points[(i + 2) % points.length];

            // Catmull-Romスプラインの制御点を計算
            const cp1x = p1.x + (p2.x - p0.x) / 6 * tension;
            const cp1y = p1.y + (p2.y - p0.y) / 6 * tension;
            const cp2x = p2.x - (p3.x - p1.x) / 6 * tension;
            const cp2y = p2.y - (p3.y - p1.y) / 6 * tension;

            if (i === 0) {
                path += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
            } else if (i < points.length - 1) {
                path += ` S ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
            }
        }
    }

    path += ' Z';
    return path;
}

// 輪郭抽出（Marching Squares アルゴリズム - 簡易版）
function traceContours(imageData) {
    const width = imageData.width;
    const height = imageData.height;
    const contours = [];

    function isBlack(x, y) {
        if (x < 0 || x >= width || y < 0 || y >= height) return false;
        const idx = (y * width + x) * 4;
        return imageData.data[idx] === 0;
    }

    // 訪問済みセルを記録
    const visited = new Uint8Array(width * height);

    console.log('輪郭を抽出中...');

    // 全てのセルをスキャン
    for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
            const idx = y * width + x;
            if (visited[idx]) continue;

            // 2x2のセルの4隅の状態を取得
            const tl = isBlack(x, y) ? 1 : 0;
            const tr = isBlack(x + 1, y) ? 1 : 0;
            const br = isBlack(x + 1, y + 1) ? 1 : 0;
            const bl = isBlack(x, y + 1) ? 1 : 0;

            // Marching Squares のケース番号（0-15）
            const cellType = tl * 8 + tr * 4 + br * 2 + bl * 1;

            // エッジがあるケースのみ処理
            if (cellType === 0 || cellType === 15) continue;

            // 輪郭をトレース
            const contour = marchingSquaresTrace(imageData, x, y, visited);
            if (contour && contour.length > 15) {  // 閾値を下げて細い線も拾う
                contours.push(contour);
                console.log(`輪郭検出: ${contour.length}点`);
            }

            // メモリ保護: 輪郭数が多すぎる場合は中断
            if (contours.length > 1000) {
                console.warn('輪郭数が1000を超えたため処理を中断');
                break;
            }
        }
        if (contours.length > 1000) break;
    }

    console.log(`合計 ${contours.length}個の輪郭を検出`);
    return contours;
}

// Marching Squares で輪郭を追跡（簡易版）
function marchingSquaresTrace(imageData, startX, startY, visited) {
    const width = imageData.width;
    const height = imageData.height;
    const contour = [];

    function isBlack(x, y) {
        if (x < 0 || x >= width || y < 0 || y >= height) return false;
        const idx = (y * width + x) * 4;
        return imageData.data[idx] === 0;
    }

    let x = startX;
    let y = startY;
    const maxSteps = 10000; // 無限ループ防止
    let steps = 0;

    do {
        const idx = y * width + x;
        if (visited[idx]) break;
        visited[idx] = 1;

        // 境界チェック
        if (x < 0 || x >= width - 1 || y < 0 || y >= height - 1) break;

        // 2x2セルの4隅
        const tl = isBlack(x, y) ? 1 : 0;
        const tr = isBlack(x + 1, y) ? 1 : 0;
        const br = isBlack(x + 1, y + 1) ? 1 : 0;
        const bl = isBlack(x, y + 1) ? 1 : 0;

        const cellType = tl * 8 + tr * 4 + br * 2 + bl * 1;

        // エッジがない場合は終了
        if (cellType === 0 || cellType === 15) break;

        // エッジ位置を計算（簡略版）
        let px = x + 0.5;
        let py = y + 0.5;

        // 基本的なケースのみ処理
        if (cellType & 0b0001) py += 0.25;
        if (cellType & 0b0010) px += 0.25;
        if (cellType & 0b0100) py -= 0.25;
        if (cellType & 0b1000) px -= 0.25;

        contour.push({ x: px, y: py });

        // 次のセルを探索（8近傍）
        let found = false;
        for (let dy = -1; dy <= 1 && !found; dy++) {
            for (let dx = -1; dx <= 1 && !found; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= width - 1 || ny < 0 || ny >= height - 1) continue;

                const nidx = ny * width + nx;
                if (visited[nidx]) continue;

                // 隣接セルにエッジがあるか確認
                const ntl = isBlack(nx, ny) ? 1 : 0;
                const ntr = isBlack(nx + 1, ny) ? 1 : 0;
                const nbr = isBlack(nx + 1, ny + 1) ? 1 : 0;
                const nbl = isBlack(nx, ny + 1) ? 1 : 0;
                const ntype = ntl * 8 + ntr * 4 + nbr * 2 + nbl * 1;

                if (ntype !== 0 && ntype !== 15) {
                    x = nx;
                    y = ny;
                    found = true;
                }
            }
        }

        if (!found) break;

        steps++;
        if (steps >= maxSteps) {
            console.warn('輪郭トレースの最大ステップ数に達しました');
            break;
        }

    } while (true);

    return contour;
}

// 輪郭を滑らかにする（Douglas-Peucker簡略化 + ガウシアン平滑化）
function smoothContour(contour, tolerance = 2.0) {
    // Douglas-Peucker アルゴリズムで点を間引く
    function simplify(points, epsilon) {
        if (points.length <= 2) return points;

        let maxDist = 0;
        let maxIndex = 0;
        const end = points.length - 1;

        for (let i = 1; i < end; i++) {
            const dist = perpendicularDistance(points[i], points[0], points[end]);
            if (dist > maxDist) {
                maxDist = dist;
                maxIndex = i;
            }
        }

        if (maxDist > epsilon) {
            const left = simplify(points.slice(0, maxIndex + 1), epsilon);
            const right = simplify(points.slice(maxIndex), epsilon);
            return left.slice(0, -1).concat(right);
        } else {
            return [points[0], points[end]];
        }
    }

    function perpendicularDistance(point, lineStart, lineEnd) {
        const dx = lineEnd.x - lineStart.x;
        const dy = lineEnd.y - lineStart.y;
        const mag = Math.sqrt(dx * dx + dy * dy);
        if (mag === 0) return Math.sqrt(Math.pow(point.x - lineStart.x, 2) + Math.pow(point.y - lineStart.y, 2));

        const u = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (mag * mag);
        const ix = lineStart.x + u * dx;
        const iy = lineStart.y + u * dy;

        return Math.sqrt(Math.pow(point.x - ix, 2) + Math.pow(point.y - iy, 2));
    }

    return simplify(contour, tolerance);
}


// PNG ダウンロード（アルファ付き）
document.getElementById('downloadPng').addEventListener('click', function() {
    const canvas = document.getElementById('alphaCanvas');

    canvas.toBlob(function(blob) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'handwriting-alpha.png';
        link.click();
        URL.revokeObjectURL(url);
    }, 'image/png');
});
