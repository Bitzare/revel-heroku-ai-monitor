const fs = require('fs');
const path = require('path');

const BACKEND_PATH = 'C:\\Users\\Rushu\\GolandProjects\\revel_backend\\handlers';
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL_NAME = 'qwen2.5-coder:14b'; // Tu nueva bestia

// Expresiones regulares para mapear el código
const FUNC_REGEX = /^func\s+(?:(?:\([^\)]+\)\s+)?)([A-Za-z0-9_]+)/;
const IF_ERR_REGEX = /^\s*if\s+err\s*!=\s*nil\s*\{/;
const HAS_LOG_REGEX = /log\.(Print|Fatal|Panic)/;

async function generateLogLine(funcName, prevLine) {
    const prompt = `
You are an expert Go developer. Write a SINGLE line of Go code using 'log.Printf' to log an error.
Do NOT use markdown. Do NOT write explanations. Return ONLY the raw Go code line.

Context:
Function Name: ${funcName}
Action that failed: ${prevLine.trim()}

Format requirement:
log.Printf("[${funcName}] Failed to <deduce action from context>: %v\\n", err)
`;

    try {
        const res = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL_NAME,
                prompt: prompt,
                stream: false,
                options: { temperature: 0.0 } // 0 creatividad, 100% precisión
            })
        });
        let line = (await res.json()).response.trim();
        // Limpiar cualquier markdown residual
        return line.replace(/```go\n?/g, '').replace(/```\n?/g, '').trim();
    } catch (e) {
        console.error("Error contactando a Ollama:", e.message);
        return null;
    }
}

async function processFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    let lines = content.split('\n');
    let currentFuncName = "Unknown";
    let modified = false;

    for (let i = 0; i < lines.length; i++) {
        // Rastrear en qué función estamos
        const funcMatch = lines[i].match(FUNC_REGEX);
        if (funcMatch) {
            currentFuncName = funcMatch[1];
        }

        // Encontramos un bloque de error
        if (IF_ERR_REGEX.test(lines[i])) {
            const indent = lines[i].match(/^\s*/)[0]; // Capturar tabulaciones/espacios
            
            // Mirar las siguientes 4 líneas para ver si ya tiene un log
            let hasLog = false;
            for (let j = 1; j <= 4 && (i + j) < lines.length; j++) {
                if (lines[i+j].includes('}')) break; // Fin del if
                if (HAS_LOG_REGEX.test(lines[i+j])) {
                    hasLog = true;
                    break;
                }
            }

            if (!hasLog) {
                // Aislar la línea anterior para saber QUÉ falló (ej: json.Unmarshal)
                let prevLine = lines[i - 1];
                // Si la línea anterior está vacía, buscar más arriba
                if (!prevLine.trim()) prevLine = lines[i - 2] || "unknown operation";

                console.log(`\n⏳ Generando log para: [${currentFuncName}] -> ${prevLine.trim()}`);
                
                const logLine = await generateLogLine(currentFuncName, prevLine);
                if (logLine && logLine.startsWith('log.')) {
                    // Inyectar el log justo debajo del 'if err != nil {'
                    lines.splice(i + 1, 0, `${indent}\t${logLine}`);
                    console.log(`   ✅ Inyectado: ${logLine}`);
                    modified = true;
                    i++; // Saltar la línea recién insertada
                } else {
                    console.log(`   ⚠️ Respuesta inválida de IA ignorada.`);
                }
            }
        }
    }

    if (modified) {
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
        console.log(`💾 Archivo guardado: ${path.basename(filePath)}`);
    }
}

async function walkDir(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            await walkDir(fullPath);
        } else if (file.name.endsWith('.go')) {
            await processFile(fullPath);
        }
    }
}

console.log("🚀 Iniciando el Agente SRE Refactorizador...");
walkDir(BACKEND_PATH).then(() => {
    console.log("\n🎉 Refactorización masiva completada.");
});