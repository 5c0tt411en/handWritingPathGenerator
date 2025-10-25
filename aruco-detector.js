let detector;
let detectedQuad = null;

// ページ読み込み後にディテクタを初期化
window.addEventListener('load', function() {
    if (typeof AR !== 'undefined') {
        detector = new AR.Detector({ dictionaryName: 'ARUCO' });
        console.log('ArUco detector initialized with ARUCO dictionary');
        console.log('Dictionary:', detector.dictionary.dicName);
        console.log('Codes:', detector.dictionary.codeList.length);
    } else {
        console.error('AR is not defined');
    }
});

document.getElementById('imageInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(event) {
            const img = new Image();
            img.onload = function() {
                processImage(img);
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    }
});

function processImage(img) {
    const statusEl = document.getElementById('status');
    statusEl.className = 'status loading';
    statusEl.textContent = 'ArUcoマーカーを検出中...';

    try {
        if (!detector) {
            throw new Error('ArUcoディテクタが初期化されていません。ページを再読み込みしてください。');
        }
        // キャンバスの準備
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        // 画像データを取得
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        console.log('画像サイズ:', canvas.width, 'x', canvas.height);
        console.log('ImageData取得完了', imageData);
        console.log('CV object:', typeof CV, 'AR object:', typeof AR);
        console.log('Detector:', detector);

        // ArUcoマーカーを検出 (js-aruco2はImageDataオブジェクトを期待)
        console.log('マーカー検出開始...');
        const markers = detector.detect(imageData);

        console.log(`検出されたマーカー数: ${markers.length}`);

        // すべての検出されたマーカーをログ出力
        markers.forEach((marker, index) => {
            console.log(`マーカー${index}: ID=${marker.id}, corners=`, marker.corners);
        });

        if (markers.length === 0) {
            throw new Error('ArUcoマーカーが検出されませんでした。画像を明るくするか、マーカーを大きくしてみてください。');
        }

        // ID 0-3のマーカーを探す (js-arucoがサポートするID範囲)
        const markerMap = {};
        markers.forEach(marker => {
            console.log(`検出: ID ${marker.id}`, marker);
            if (marker.id >= 0 && marker.id <= 3) {
                // マーカーの中心座標を計算
                const centerX = (marker.corners[0].x + marker.corners[1].x + marker.corners[2].x + marker.corners[3].x) / 4;
                const centerY = (marker.corners[0].y + marker.corners[1].y + marker.corners[2].y + marker.corners[3].y) / 4;
                markerMap[marker.id] = {
                    id: marker.id,
                    x: centerX,
                    y: centerY,
                    corners: marker.corners
                };
            }
        });

        if (Object.keys(markerMap).length !== 4) {
            throw new Error(`ID 0-3のマーカーが4つ必要です（検出数: ${Object.keys(markerMap).length}）`);
        }

        // マーカーを描画
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 2;
        markers.forEach(marker => {
            ctx.beginPath();
            ctx.moveTo(marker.corners[0].x, marker.corners[0].y);
            for (let i = 1; i < marker.corners.length; i++) {
                ctx.lineTo(marker.corners[i].x, marker.corners[i].y);
            }
            ctx.closePath();
            ctx.stroke();

            // IDを表示
            const centerX = (marker.corners[0].x + marker.corners[2].x) / 2;
            const centerY = (marker.corners[0].y + marker.corners[2].y) / 2;
            ctx.fillStyle = '#ff0000';
            ctx.font = 'bold 24px Arial';
            ctx.fillText(marker.id.toString(), centerX - 8, centerY + 8);
        });

        // マーカーの位置から四角形を構成
        // Y座標でソート（上2つ、下2つ）
        const sortedMarkers = Object.values(markerMap);
        sortedMarkers.sort((a, b) => a.y - b.y);
        const topTwo = sortedMarkers.slice(0, 2).sort((a, b) => a.x - b.x);
        const bottomTwo = sortedMarkers.slice(2, 4).sort((a, b) => a.x - b.x);

        const orderedPoints = [
            topTwo[0],      // 左上
            topTwo[1],      // 右上
            bottomTwo[1],   // 右下
            bottomTwo[0]    // 左下
        ];

        detectedQuad = orderedPoints;

        // 四角形を描画
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(orderedPoints[0].x, orderedPoints[0].y);
        for (let i = 1; i < orderedPoints.length; i++) {
            ctx.lineTo(orderedPoints[i].x, orderedPoints[i].y);
        }
        ctx.closePath();
        ctx.stroke();

        // 各点を描画
        orderedPoints.forEach((point, index) => {
            ctx.fillStyle = '#00ff00';
            ctx.beginPath();
            ctx.arc(point.x, point.y, 8, 0, 2 * Math.PI);
            ctx.fill();
        });

        // SVGを生成
        generateSVG(orderedPoints, img.width, img.height);

        statusEl.className = 'status success';
        statusEl.textContent = `ArUcoマーカー ${markers.length}個を検出し、内側の四角形を抽出しました！`;

        document.getElementById('downloadSvg').disabled = false;
        document.getElementById('copySvg').disabled = false;

    } catch (error) {
        console.error(error);
        statusEl.className = 'status error';
        statusEl.textContent = `エラー: ${error.message}`;
    }
}

function generateSVG(points, width, height) {
    const svg = document.getElementById('svgOutput');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // SVGのパスを作成
    const pathData = `M ${points[0].x} ${points[0].y} ` +
                     `L ${points[1].x} ${points[1].y} ` +
                     `L ${points[2].x} ${points[2].y} ` +
                     `L ${points[3].x} ${points[3].y} Z`;

    svg.innerHTML = `
        <path d="${pathData}"
              fill="none"
              stroke="#00ff00"
              stroke-width="5" />
        ${points.map((p, i) => `
            <circle cx="${p.x}" cy="${p.y}" r="10" fill="#00ff00" />
            <text x="${p.x}" y="${p.y + 5}"
                  text-anchor="middle"
                  font-size="20"
                  fill="white"
                  font-weight="bold">${p.id}</text>
        `).join('')}
    `;
}

function getSVGCode() {
    if (!detectedQuad) return '';

    const canvas = document.getElementById('canvas');
    const viewBox = `0 0 ${canvas.width} ${canvas.height}`;

    const pathData = `M ${detectedQuad[0].x} ${detectedQuad[0].y} ` +
                     `L ${detectedQuad[1].x} ${detectedQuad[1].y} ` +
                     `L ${detectedQuad[2].x} ${detectedQuad[2].y} ` +
                     `L ${detectedQuad[3].x} ${detectedQuad[3].y} Z`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">
    <path d="${pathData}" fill="none" stroke="#00ff00" stroke-width="5" />
</svg>`;
}

document.getElementById('downloadSvg').addEventListener('click', function() {
    const svgCode = getSVGCode();
    const blob = new Blob([svgCode], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aruco-quad.svg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

document.getElementById('copySvg').addEventListener('click', function() {
    const svgCode = getSVGCode();
    navigator.clipboard.writeText(svgCode).then(() => {
        const btn = document.getElementById('copySvg');
        const originalText = btn.textContent;
        btn.textContent = 'コピーしました！';
        setTimeout(() => {
            btn.textContent = originalText;
        }, 2000);
    });
});
