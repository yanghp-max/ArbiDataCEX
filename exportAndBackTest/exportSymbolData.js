const mysql = require('mysql2'); 
const mysqlPromise = require('mysql2/promise');
const fs = require('fs-extra');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

// --- 1. 数据库配置 ---
const dbConfig = {
    host: '13.112.42.154',
    user: 'root',
    password: 'Yhp.949941400',
    database: 'arbidata',
    dateStrings: true,
    connectTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
};

// --- 2. 时间范围配置 ---
const TIME_RANGE = {
    startDateTime: "", 
    endDateTime: ""
};

// --- 3. 币种过滤配置 ---
// 留空数组表示导出全部币种；填写后仅导出数组中的 symbol。
// 例如: ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
const TARGET_SYMBOLS = ["BTCUSDT", "BUSDT", "CFXUSDT", "CHZUSDT", "DOGEUSDT", "DOTUSDT", "ENAUSDT", "ETHUSDT", "FARTCOINUSDT", "FILUSDT", "HYPEUSDT", "ICPUSDT", "IRYSUSDT", "LABUSDT", "LINKUSDT", "LTCUSDT", "NEARUSDT", "ONDOUSDT", "ORCAUSDT", "PHBUSDT", "RAVEUSDT", "RECALLUSDT", "RIVERUSDT", "SAGAUSDT", "SIRENUSDT", "SKYAIUSDT", "SOLUSDT", "STORJUSDT", "SUIUSDT", "TAOUSDT", "TONUSDT", "TRUMPUSDT", "TRUTHUSDT", "UBUSDT", "UNIUSDT", "VIRTUALUSDT", "VVVUSDT", "WLFIUSDT", "XAUTUSDT", "XRPUSDT", "ZECUSDT"];

function getTargetSymbols() {
    return TARGET_SYMBOLS
        .map(s => String(s || '').trim())
        .filter(Boolean);
}

/**
 * 格式化耗时显示 (00:00:00 格式)
 */
function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
    const s = (totalSeconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function getTimestampDir() {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    return path.join(process.cwd(), `data_export_${ts}`);
}

async function runExportTask() {
    const taskStart = Date.now();
    const outputDir = getTimestampDir();
    await fs.ensureDir(outputDir);
    
    const connection = await mysqlPromise.createConnection(dbConfig);
    const hasStartTime = !!(TIME_RANGE.startDateTime && TIME_RANGE.startDateTime.trim());
    const hasEndTime = !!(TIME_RANGE.endDateTime && TIME_RANGE.endDateTime.trim());
    const targetSymbols = getTargetSymbols();
    const hasSymbolFilter = targetSymbols.length > 0;

    let totalGlobalRows = 0;

    try {
        console.log(`\n[${new Date().toLocaleTimeString()}] 🚀 导出任务启动`);
        
        let symbolsToExport = [];
        if (hasStartTime || hasEndTime) {
            console.log(`📅 模式: 时间范围过滤`);
            let query = 'SELECT DISTINCT symbol FROM price_history WHERE 1=1';
            let params = [];
            if (hasStartTime) { query += ' AND datetime >= ?'; params.push(TIME_RANGE.startDateTime); }
            if (hasEndTime) { query += ' AND datetime <= ?'; params.push(TIME_RANGE.endDateTime); }
            if (hasSymbolFilter) {
                query += ` AND symbol IN (${targetSymbols.map(() => '?').join(',')})`;
                params.push(...targetSymbols);
            }
            const [rows] = await connection.query(query, params);
            symbolsToExport = rows.map(r => ({ symbol: r.symbol, maxId: null }));
        } else {
            console.log(`🔒 模式: 全量快照锁定`);
            let query = `SELECT symbol, MAX(id) as maxId FROM price_history`;
            let params = [];
            if (hasSymbolFilter) {
                query += ` WHERE symbol IN (${targetSymbols.map(() => '?').join(',')})`;
                params.push(...targetSymbols);
            }
            query += ` GROUP BY symbol`;
            const [rows] = await connection.query(query, params);
            symbolsToExport = rows;
        }

        console.log(`📊 找到 ${symbolsToExport.length} 个交易对 | 目录: ${outputDir}\n`);

        for (let i = 0; i < symbolsToExport.length; i++) {
            const { symbol, maxId } = symbolsToExport[i];
            const safeSymbol = symbol.replace(/[/\\?%*:|"<>]/g, '_');
            const filePath = path.join(outputDir, `${safeSymbol}.csv`);

            const symbolStart = Date.now();
            
            // 使用自定义函数处理带动态进度的同步
            const rowCount = await startStreamPipeline(symbol, maxId, filePath, i + 1, symbolsToExport.length, symbolStart);
            
            const symbolEnd = Date.now();
            totalGlobalRows += rowCount;
            
            // 同步完成后，清除动态行并打印最终静态结果
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            console.log(`[${i + 1}/${symbolsToExport.length}] ✅ ${symbol.padEnd(12)} | 导出: ${rowCount.toLocaleString().padStart(10)} 条 | 耗时: ${formatDuration(symbolEnd - symbolStart)}`);
        }

        const taskTotalTime = Date.now() - taskStart;
        console.log(`\n🎉 任务圆满完成！`);
        console.log(`📈 累计总行数: ${totalGlobalRows.toLocaleString()}`);
        console.log(`⏱️ 总共运行时间: ${formatDuration(taskTotalTime)}`);

    } catch (err) {
        console.error('\n❌ 任务失败:', err);
    } finally {
        await connection.end();
    }
}

async function startStreamPipeline(symbol, maxId, filePath, currentIdx, totalIdx, startTime) {
    const pool = mysql.createPool({ ...dbConfig, connectionLimit: 1 });
    let isFirstRow = true;
    let count = 0;

    const csvTransformer = new Transform({
        writableObjectMode: true,
        highWaterMark: 1000, 
        transform(row, encoding, callback) {
            let chunk = "";
            if (isFirstRow) {
                chunk += Object.keys(row).join(',') + '\n';
                isFirstRow = false;
            }
            chunk += Object.values(row).map(v => {
                if (v === null || v === undefined) return '';
                const s = String(v);
                return (s.includes(',') || s.includes('"') || s.includes('\n')) 
                    ? `"${s.replace(/"/g, '""')}"` : s;
            }).join(',') + '\n';

            count++;
            
            // 每 10,000 条更新一次动态进度（这个频率既能保证实时感，又不浪费 CPU）
            if (count % 10000 === 0) {
                const elapsed = Date.now() - startTime;
                process.stdout.clearLine(0);
                process.stdout.cursorTo(0);
                process.stdout.write(`[${currentIdx}/${totalIdx}] ⏳ 同步中: ${symbol.padEnd(12)} | 已处理: ${count.toLocaleString().padStart(10)} 条 | 已用时: ${formatDuration(elapsed)}`);
            }
            
            callback(null, chunk);
        }
    });

    const writer = fs.createWriteStream(filePath);

    let sql = 'SELECT * FROM price_history WHERE symbol = ?';
    let params = [symbol];
    if (maxId) {
        sql += ' AND id <= ? ORDER BY id ASC';
        params.push(maxId);
    } else {
        if (TIME_RANGE.startDateTime) { sql += ' AND datetime >= ?'; params.push(TIME_RANGE.startDateTime); }
        if (TIME_RANGE.endDateTime) { sql += ' AND datetime <= ?'; params.push(TIME_RANGE.endDateTime); }
        sql += ' ORDER BY datetime ASC, id ASC';
    }

    const dbStream = pool.query(sql, params).stream({ highWaterMark: 1000 });

    try {
        await pipeline(dbStream, csvTransformer, writer);
        return count;
    } finally {
        pool.end();
    }
}

runExportTask();