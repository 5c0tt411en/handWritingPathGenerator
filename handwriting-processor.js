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
        const outputSize = 800; // 出力画像のサイズ
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

    // 二値化画像を表示
    const binaryCanvas = document.getElementById('binaryCanvas');
    binaryCanvas.width = width;
    binaryCanvas.height = height;
    const binaryCtx = binaryCanvas.getContext('2d');
    binaryCtx.putImageData(binaryData, 0, 0);

    // SVG生成を非同期で実行
    statusEl.textContent = '輪郭をトレース中...（少々お待ちください）';

    setTimeout(() => {
        try {
            generateSVG(binaryData);
            statusEl.className = 'status success';
            statusEl.textContent = '✓ SVG変換が完了しました！';
        } catch (error) {
            console.error(error);
            statusEl.className = 'status error';
            statusEl.textContent = `エラー: ${error.message}`;
        }
    }, 100);
}

// SVG生成（輪郭トレース版）
function generateSVG(binaryData) {
    const width = binaryData.width;
    const height = binaryData.height;

    const svg = document.getElementById('svgOutput');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // 二値画像から輪郭を抽出
    console.log('輪郭抽出を開始...');
    const contours = traceContours(binaryData);
    console.log(`${contours.length}個の輪郭を検出`);

    // 輪郭を滑らかなパスに変換
    // 全ての輪郭を1つのパスにまとめる（fill-rule="evenodd"で穴を表現）
    let combinedPath = '';
    contours.forEach((contour, i) => {
        if (contour.length < 3) return; // 3点未満は無視

        const smoothed = smoothContour(contour);
        const pathData = contourToPath(smoothed);
        combinedPath += pathData + ' ';
    });

    if (combinedPath) {
        svg.innerHTML = `<path d="${combinedPath}" fill="black" fill-rule="evenodd"/>`;
    } else {
        svg.innerHTML = '';
    }
}

// 輪郭抽出（Marching Squares アルゴリズム）
function traceContours(imageData) {
    const width = imageData.width;
    const height = imageData.height;
    const contours = [];

    function isBlack(x, y) {
        if (x < 0 || x >= width || y < 0 || y >= height) return false;
        const idx = (y * width + x) * 4;
        return imageData.data[idx] === 0;
    }

    // 訪問済みエッジを記録
    const visitedEdges = new Set();

    console.log('  Marching Squares で輪郭を抽出中...');

    // 全てのセルをスキャンして輪郭の開始点を探す
    for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
            // 2x2のセルの4隅の状態を取得
            const tl = isBlack(x, y) ? 1 : 0;
            const tr = isBlack(x + 1, y) ? 1 : 0;
            const br = isBlack(x + 1, y + 1) ? 1 : 0;
            const bl = isBlack(x, y + 1) ? 1 : 0;

            // Marching Squares のケース番号（0-15）
            const cellType = tl * 8 + tr * 4 + br * 2 + bl * 1;

            // エッジがあるケースのみ処理（0と15は完全に内側または外側）
            if (cellType === 0 || cellType === 15) continue;

            // このセルから輪郭をトレース開始
            const edgeKey = `${x},${y}`;
            if (visitedEdges.has(edgeKey)) continue;

            const contour = marchingSquaresTrace(imageData, x, y, visitedEdges);
            if (contour && contour.length > 10) {
                contours.push(contour);
            }
        }
    }

    console.log(`  ${contours.length}個の輪郭を検出`);
    return contours;
}

// Marching Squares で輪郭を追跡
function marchingSquaresTrace(imageData, startX, startY, visitedEdges) {
    const width = imageData.width;
    const height = imageData.height;
    const contour = [];

    function isBlack(x, y) {
        if (x < 0 || x >= width || y < 0 || y >= height) return false;
        const idx = (y * width + x) * 4;
        return imageData.data[idx] === 0;
    }

    // 現在のセル位置
    let x = startX;
    let y = startY;
    let prevDir = -1;

    const maxSteps = width * height * 4; // 無限ループ防止
    let steps = 0;

    do {
        const edgeKey = `${x},${y}`;
        visitedEdges.add(edgeKey);

        // 2x2セルの4隅
        const tl = isBlack(x, y) ? 1 : 0;
        const tr = isBlack(x + 1, y) ? 1 : 0;
        const br = isBlack(x + 1, y + 1) ? 1 : 0;
        const bl = isBlack(x, y + 1) ? 1 : 0;

        const cellType = tl * 8 + tr * 4 + br * 2 + bl * 1;

        // セルの中心点を輪郭に追加（線形補間で精度向上）
        let px = x + 0.5;
        let py = y + 0.5;

        // Marching Squares のルックアップテーブル
        // 各ケースに対してエッジの方向を決定
        let nextDir = -1;

        switch (cellType) {
            case 1: px = x + 0.25; py = y + 0.75; nextDir = 2; break; // 左下
            case 2: px = x + 0.75; py = y + 0.75; nextDir = 1; break; // 右下
            case 3: px = x + 0.5; py = y + 1; nextDir = 1; break; // 下
            case 4: px = x + 0.75; py = y + 0.25; nextDir = 0; break; // 右上
            case 5: // あいまいなケース
                px = x + 0.5; py = y + 0.5;
                nextDir = prevDir === 3 ? 0 : 2;
                break;
            case 6: px = x + 1; py = y + 0.5; nextDir = 0; break; // 右
            case 7: px = x + 0.75; py = y + 0.25; nextDir = 0; break; // 右上
            case 8: px = x + 0.25; py = y + 0.25; nextDir = 3; break; // 左上
            case 9: px = x; py = y + 0.5; nextDir = 2; break; // 左
            case 10: // あいまいなケース
                px = x + 0.5; py = y + 0.5;
                nextDir = prevDir === 1 ? 2 : 0;
                break;
            case 11: px = x + 0.25; py = y + 0.75; nextDir = 2; break; // 左下
            case 12: px = x + 0.5; py = y; nextDir = 3; break; // 上
            case 13: px = x + 0.25; py = y + 0.25; nextDir = 3; break; // 左上
            case 14: px = x + 0.75; py = y + 0.75; nextDir = 1; break; // 右下
            default: nextDir = -1;
        }

        if (nextDir !== -1) {
            contour.push({ x: px, y: py });
        }

        // 次のセルへ移動
        switch (nextDir) {
            case 0: x++; break;     // 右
            case 1: y++; break;     // 下
            case 2: x--; break;     // 左
            case 3: y--; break;     // 上
            default: return null;   // エラー
        }

        prevDir = nextDir;
        steps++;

        // 境界チェック
        if (x < 0 || x >= width - 1 || y < 0 || y >= height - 1) break;

        // 開始点に戻ったら終了
        if (x === startX && y === startY && contour.length > 2) break;

    } while (steps < maxSteps);

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

// 輪郭をSVGパスに変換（ベジェ曲線で滑らかに）
function contourToPath(contour) {
    if (contour.length < 2) return '';

    let path = `M ${contour[0].x},${contour[0].y}`;

    if (contour.length === 2) {
        path += ` L ${contour[1].x},${contour[1].y}`;
    } else {
        // Catmull-Rom スプライン補間でベジェ曲線を生成
        for (let i = 0; i < contour.length; i++) {
            const p0 = contour[(i - 1 + contour.length) % contour.length];
            const p1 = contour[i];
            const p2 = contour[(i + 1) % contour.length];
            const p3 = contour[(i + 2) % contour.length];

            // カトマル・ロムからベジェ曲線の制御点を計算
            const cp1x = p1.x + (p2.x - p0.x) / 6;
            const cp1y = p1.y + (p2.y - p0.y) / 6;
            const cp2x = p2.x - (p3.x - p1.x) / 6;
            const cp2y = p2.y - (p3.y - p1.y) / 6;

            if (i === 0) {
                path += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
            } else if (i < contour.length - 1) {
                path += ` S ${cp2x},${cp2y} ${p2.x},${p2.y}`;
            }
        }
    }

    path += ' Z';
    return path;
}

// SVGダウンロード
document.getElementById('downloadSvg').addEventListener('click', function() {
    const svg = document.getElementById('svgOutput');
    const svgData = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'handwriting.svg';
    link.click();
    URL.revokeObjectURL(url);
});

// PNG ダウンロード
document.getElementById('downloadPng').addEventListener('click', function() {
    const canvas = document.getElementById('correctedCanvas');
    canvas.toBlob(function(blob) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'corrected-drawing.png';
        link.click();
        URL.revokeObjectURL(url);
    });
});

// SVGコピー
document.getElementById('copySvg').addEventListener('click', function() {
    const svg = document.getElementById('svgOutput');
    const svgData = new XMLSerializer().serializeToString(svg);
    navigator.clipboard.writeText(svgData).then(() => {
        const btn = document.getElementById('copySvg');
        const originalText = btn.textContent;
        btn.textContent = 'コピーしました！';
        setTimeout(() => {
            btn.textContent = originalText;
        }, 2000);
    });
});
