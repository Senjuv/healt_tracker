import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { 
    getAuth, signInAnonymously, signInWithCustomToken, 
    onAuthStateChanged 
} from 'firebase/auth';
import { 
    getFirestore, doc, setDoc, 
    onSnapshot, collection, query, 
    // Se elimina 'orderBy' para evitar errores de índice y permisos
    // en entornos de desarrollo o Canvas.
} from 'firebase/firestore';

// --- CONFIGURACIÓN DE FIREBASE Y VARIABLES GLOBALES ---
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-health-app';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Habilitar logging para debug (útil para ver si la consulta se dispara)
// import { setLogLevel } from 'firebase/firestore';
// setLogLevel('debug'); 

const API_MODEL_TEXT = "gemini-2.5-flash-preview-09-2025";
const API_URL_TEXT = `https://generativelanguage.googleapis.com/v1beta/models/${API_MODEL_TEXT}:generateContent?key=`;

// URL para el placeholder de carga de imagen/documento (si el usuario no sube una)
const DEFAULT_IMAGE_URL = "https://placehold.co/100x100/A0A0A0/FFFFFF?text=IMAGEN";

// --- UTILIDADES ---

/**
 * Convierte un archivo a base64.
 * @param {File} file - El archivo a convertir.
 * @returns {Promise<string>} Promesa que resuelve en la cadena base64.
 */
const fileToBase64 = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = (error) => reject(error);
    });
};

/**
 * Función de retardo para el retroceso exponencial (exponential backoff).
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Ejecuta una llamada a la API de Gemini con reintentos.
 */
const fetchWithRetry = async (url, options, maxRetries = 3) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                // Si la respuesta no es OK, revisamos si es un error 429 (Rate Limit) o 5xx (Servidor)
                if (response.status === 429 || response.status >= 500) {
                    throw new Error(`Server or Rate Limit Error: ${response.status}`);
                }
                // Para otros errores (400, 403), salimos del bucle de reintentos
                const errorBody = await response.json();
                console.error("API Error Response:", errorBody);
                throw new Error(errorBody.error?.message || `HTTP Error: ${response.status}`);
            }
            return response.json();
        } catch (error) {
            if (i === maxRetries - 1) {
                console.error("Fetch failed after all retries:", error);
                throw error;
            }
            const backoffTime = Math.pow(2, i) * 1000 + Math.random() * 1000;
            console.warn(`Retry ${i + 1}/${maxRetries}. Retrying in ${backoffTime / 1000}s due to: ${error.message}`);
            await delay(backoffTime);
        }
    }
};

// --- COMPONENTES UI BÁSICOS ---

const Spinner = () => (
    <div className="flex items-center justify-center space-x-2">
        <div className="w-4 h-4 rounded-full animate-pulse bg-indigo-500"></div>
        <div className="w-4 h-4 rounded-full animate-pulse bg-indigo-500"></div>
        <div className="w-4 h-4 rounded-full animate-pulse bg-indigo-500"></div>
    </div>
);

const IconButton = ({ children, onClick, disabled = false }) => (
    <button 
        onClick={onClick} 
        disabled={disabled}
        className={`p-2 rounded-full transition-all duration-300 shadow-lg 
            ${disabled ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800'} 
            text-white flex items-center justify-center`}
    >
        {children}
    </button>
);

// --- FUNCIONES DE LA API DE GEMINI ---

/**
 * Función principal para la generación de texto simple.
 */
const generateContent = async (systemPrompt, userQuery) => {
    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
    };

    const response = await fetchWithRetry(API_URL_TEXT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("No se pudo obtener la respuesta de la IA.");
    return text;
};

/**
 * Función para análisis multimodal (Imagen + Texto).
 */
const generateMultimodalContent = async (systemPrompt, userQuery, base64Image) => {
    const payload = {
        contents: [{ 
            parts: [
                { text: userQuery },
                { inlineData: { mimeType: "image/png", data: base64Image } }
            ]
        }],
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
    };

    const response = await fetchWithRetry(API_URL_TEXT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("No se pudo obtener la respuesta de la IA.");
    return text;
};

// --- CONTEXTO DE FIREBASE ---

const dbContext = {
    app: null,
    db: null,
    auth: null,
    userId: null,
};

// --- COMPONENTES PRINCIPALES ---

const RecordWeight = ({ db, userId, onRecord }) => {
    const [weight, setWeight] = useState('');
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');

    const handleRecord = async () => {
        if (!db || !userId) {
            setMessage('Error: Autenticación no lista. Espera a que cargue el ID de usuario.');
            return;
        }
        const numericWeight = parseFloat(weight);
        if (isNaN(numericWeight) || numericWeight <= 0) {
            setMessage('Por favor, ingresa un peso válido.');
            return;
        }

        setLoading(true);
        setMessage('');

        try {
            const timestamp = new Date().toISOString();
            const weightData = {
                weight: numericWeight,
                timestamp: timestamp,
                date: new Date().toLocaleDateString('es-MX'),
            };

            // Asegurar la ruta privada
            const docRef = doc(db, `artifacts/${appId}/users/${userId}/weights`, timestamp);
            await setDoc(docRef, weightData);
            
            setMessage('Peso registrado con éxito.');
            setWeight('');
            onRecord(numericWeight); // Actualiza el estado principal
        } catch (error) {
            console.error("Error al registrar el peso:", error);
            setMessage(`Error al registrar: ${error.message}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="bg-white p-4 rounded-lg shadow-md mb-6">
            <h3 className="text-lg font-semibold mb-3 text-indigo-700">Registro Diario de Peso</h3>
            <div className="flex space-x-3 items-center">
                <input
                    type="number"
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                    placeholder="Peso (kg o lb)"
                    className="w-full p-2 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
                    disabled={loading}
                />
                <button
                    onClick={handleRecord}
                    disabled={loading || !weight}
                    className="bg-green-500 text-white p-2 rounded-lg hover:bg-green-600 transition duration-150 disabled:bg-gray-400 shadow-md"
                >
                    {loading ? <Spinner /> : "Registrar"}
                </button>
            </div>
            {message && <p className="mt-2 text-sm text-center" style={{ color: message.includes('Error') ? 'red' : 'green' }}>{message}</p>}
        </div>
    );
};

const WeightHistory = ({ weightData }) => {
    if (weightData.length === 0) {
        return <p className="text-gray-500 text-center py-4">Aún no hay registros de peso.</p>;
    }

    // Ordenar por fecha (timestamp) descendente para la tabla.
    const sortedData = [...weightData].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Para el cálculo de progreso, usamos el array original que ya viene ordenado ascendente 
    // desde el listener (que ahora ordena en memoria).
    const sortedForCalc = weightData; 

    const initialWeight = sortedForCalc[0].weight;
    const currentWeight = sortedForCalc[sortedForCalc.length - 1].weight;
    
    const difference = currentWeight - initialWeight;
    const status = difference > 0 ? 'Ganancia' : difference < 0 ? 'Pérdida' : 'Sin cambios';

    const colorClass = difference > 0 ? 'text-red-600' : difference < 0 ? 'text-green-600' : 'text-gray-600';

    return (
        <div className="bg-white p-4 rounded-lg shadow-md">
            <h3 className="text-lg font-semibold mb-3 text-indigo-700">Historial y Progreso</h3>
            <div className={`p-3 mb-4 rounded-lg border-2 ${difference !== 0 ? 'border-dashed border-indigo-400' : 'border-gray-300'}`}>
                <p className="text-sm font-medium">Peso Inicial: <span className="font-bold">{initialWeight}</span></p>
                <p className="text-sm font-medium">Peso Actual: <span className="font-bold">{currentWeight}</span></p>
                <p className={`text-lg font-bold ${colorClass}`}>
                    Progreso Total: {status} de {Math.abs(difference).toFixed(2)}
                </p>
            </div>
            
            <div className="max-h-64 overflow-y-auto">
                <table className="min-w-full text-left text-sm bg-gray-50 rounded-lg">
                    <thead className="sticky top-0 bg-indigo-100">
                        <tr>
                            <th className="py-2 px-3">Fecha</th>
                            <th className="py-2 px-3 text-right">Peso</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sortedData.map((data) => (
                            <tr key={data.timestamp} className="border-t hover:bg-indigo-50">
                                <td className="py-2 px-3 text-gray-700">{data.date}</td>
                                <td className="py-2 px-3 text-right font-medium">{data.weight}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};


// --- HERRAMIENTAS IA ---

const AiTools = ({ weightData }) => {
    const [activeTool, setActiveTool] = useState('meal');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);

    // --- Estados para Análisis de Fotos de Comida ---
    const [foodImageFile, setFoodImageFile] = useState(null);
    const [foodImagePreviewUrl, setFoodImagePreviewUrl] = useState(DEFAULT_IMAGE_URL);


    // --- 1. Planificador Nutricional (Texto) ---
    const [goal, setGoal] = useState('');
    const [ingredients, setIngredients] = useState('');

    const handlePlanMeal = async () => {
        if (!goal) { setError("Por favor, describe tu objetivo nutricional."); return; }
        setError(null);
        setResult(null);
        setLoading(true);

        try {
            const systemPrompt = "Eres un nutricionista experto y motivador. Genera un plan de comidas (desayuno, almuerzo, cena) en formato Markdown para un día basado en el objetivo del usuario. Sé detallado con los ingredientes y las macros estimadas. Responde únicamente con el plan de comidas.";
            
            let userQuery = `Mi objetivo es: ${goal}.`;
            if (ingredients) {
                userQuery += ` Además, prioriza el uso de estos ingredientes: ${ingredients}.`;
            }

            const response = await generateContent(systemPrompt, userQuery);
            setResult(response);
        } catch (e) {
            setError(`Error al generar el plan: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };

    // --- 2. Análisis de Fotos de Comida (Multimodal) ---
    const handleAnalyzeFood = async () => {
        if (!foodImageFile) { setError("Por favor, sube una foto de tu comida."); return; }
        setError(null);
        setResult(null);
        setLoading(true);

        try {
            const base64Image = await fileToBase64(foodImageFile);
            
            const systemPrompt = "Eres un nutricionista experto. Analiza la foto de la comida. Estima el tipo de plato, los ingredientes principales, y proporciona una estimación de calorías y un desglose macro. Responde en español y en formato Markdown.";
            const userQuery = "Analiza esta comida para obtener información nutricional (calorías, macros).";

            const response = await generateMultimodalContent(systemPrompt, userQuery, base64Image);
            setResult(response);

        } catch (e) {
            console.error("Error en el análisis de comida:", e);
            setError(`Error al analizar la comida: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };
    
    // --- 3. Analizador de Síntomas (Texto) ---
    const [symptom, setSymptom] = useState('');

    const handleAnalyzeSymptom = async () => {
        if (!symptom) { setError("Por favor, describe tu síntoma."); return; }
        setError(null);
        setResult(null);
        setLoading(true);

        try {
            const systemPrompt = "Eres un asistente de bienestar que ofrece sugerencias nutricionales basadas en síntomas reportados. Siempre incluye una advertencia de que NO eres un médico. Sugiere vitaminas, minerales o alimentos específicos que podrían ayudar con el síntoma reportado. Responde en español y en formato Markdown.";
            const userQuery = `Estoy experimentando: ${symptom}. ¿Qué nutrientes y alimentos podrían ayudar?`;

            const response = await generateContent(systemPrompt, userQuery);
            setResult(response);
        } catch (e) {
            setError(`Error al analizar el síntoma: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };

    // --- 4. Consejos de Progreso (Texto con Datos) ---
    const handleGetAdvice = async () => {
        setError(null);
        setResult(null);
        setLoading(true);

        if (weightData.length < 2) {
            setError("Necesitas al menos dos registros de peso para generar un consejo de progreso significativo.");
            setLoading(false);
            return;
        }

        try {
            const systemPrompt = "Eres un coach de salud y fitness. Analiza los datos de peso proporcionados y ofrece un mensaje de motivación o un consejo actionable (una acción específica) para el usuario. El tono debe ser positivo y alentador. Responde en español y en un párrafo corto.";
            
            // Los datos de weightData ya están ordenados por timestamp ascendente
            const sortedData = weightData; 
            
            let dataSummary = sortedData.map(d => `${d.date}: ${d.weight}`).join(' | ');
            dataSummary = `Historial de peso (Fecha: Peso): ${dataSummary}`;

            const response = await generateContent(systemPrompt, dataSummary);
            setResult(response);
        } catch (e) {
            setError(`Error al obtener consejos: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };

    const renderToolInput = () => {
        switch (activeTool) {
            case 'meal':
                return (
                    <div>
                        <input
                            type="text"
                            placeholder="Objetivo (ej. ganar músculo, perder peso)"
                            value={goal}
                            onChange={(e) => setGoal(e.target.value)}
                            className="w-full p-2 border border-gray-300 rounded-lg mb-3"
                        />
                        <textarea
                            placeholder="Ingredientes que tienes disponibles (opcional)"
                            value={ingredients}
                            onChange={(e) => setIngredients(e.target.value)}
                            className="w-full p-2 border border-gray-300 rounded-lg mb-3 h-20"
                        ></textarea>
                        <button
                            onClick={handlePlanMeal}
                            disabled={loading || !goal}
                            className="w-full bg-indigo-500 text-white p-2 rounded-lg hover:bg-indigo-600 disabled:bg-gray-400"
                        >
                            {loading ? <Spinner /> : "Generar Plan de Comidas"}
                        </button>
                    </div>
                );
            case 'food':
                return (
                    <div>
                        <div className="flex flex-col items-center p-4 border rounded-lg bg-gray-50 mb-3">
                            <img src={foodImagePreviewUrl} alt="Vista previa de la comida" className="w-24 h-24 object-cover rounded-lg mb-3 border-2 border-indigo-300 shadow-md" />
                            <input
                                type="file"
                                accept="image/png, image/jpeg"
                                onChange={(e) => {
                                    const file = e.target.files[0];
                                    if (file) {
                                        setFoodImageFile(file);
                                        setFoodImagePreviewUrl(URL.createObjectURL(file));
                                    }
                                }}
                                className="text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
                            />
                        </div>
                        <button
                            onClick={handleAnalyzeFood}
                            disabled={loading || !foodImageFile}
                            className="w-full bg-indigo-500 text-white p-2 rounded-lg hover:bg-indigo-600 disabled:bg-gray-400"
                        >
                            {loading ? <Spinner /> : "Analizar Foto de Comida"}
                        </button>
                    </div>
                );
            case 'symptom':
                return (
                    <div>
                        <textarea
                            placeholder="Describe brevemente el síntoma que experimentas (ej. fatiga, ansiedad por la comida, calambres)"
                            value={symptom}
                            onChange={(e) => setSymptom(e.target.value)}
                            className="w-full p-2 border border-gray-300 rounded-lg mb-3 h-20"
                        ></textarea>
                         <button
                            onClick={handleAnalyzeSymptom}
                            disabled={loading || !symptom}
                            className="w-full bg-indigo-500 text-white p-2 rounded-lg hover:bg-indigo-600 disabled:bg-gray-400"
                        >
                            {loading ? <Spinner /> : "Analizar Síntoma"}
                        </button>
                    </div>
                );
            case 'advice':
                return (
                    <div>
                        <p className="text-gray-600 mb-4">
                            Analizaré tu historial de peso para darte consejos personalizados y motivación. (Registros necesarios: {weightData.length >= 2 ? 'OK' : `Faltan ${2 - weightData.length}`})
                        </p>
                        <button
                            onClick={handleGetAdvice}
                            disabled={loading || weightData.length < 2}
                            className="w-full bg-indigo-500 text-white p-2 rounded-lg hover:bg-indigo-600 disabled:bg-gray-400"
                        >
                            {loading ? <Spinner /> : "Obtener Consejo de Progreso"}
                        </button>
                    </div>
                );
            default:
                return null;
        }
    };

    return (
        <div className="bg-white p-6 rounded-xl shadow-2xl">
            <h2 className="text-2xl font-bold mb-4 text-indigo-700 border-b pb-2">Herramientas Nutricionales con IA</h2>
            
            {/* Pestañas de Navegación */}
            <div className="flex space-x-2 mb-4 overflow-x-auto pb-2">
                {['meal', 'food', 'symptom', 'advice'].map(tab => (
                    <button
                        key={tab}
                        onClick={() => { setActiveTool(tab); setResult(null); setError(null); }}
                        className={`p-2 rounded-lg font-medium transition duration-150 whitespace-nowrap
                            ${activeTool === tab 
                                ? 'bg-indigo-100 text-indigo-700 border-b-2 border-indigo-500' 
                                : 'text-gray-600 hover:bg-gray-100'}`
                        }
                    >
                        {tab === 'meal' ? 'Planificador Nutricional' : tab === 'food' ? 'Análisis de Foto' : tab === 'symptom' ? 'Analizador de Síntomas' : 'Consejos de Progreso'}
                    </button>
                ))}
            </div>

            {/* Input del Tool Activo */}
            <div className="p-4 border border-gray-200 rounded-lg bg-gray-50 mb-4">
                {renderToolInput()}
            </div>

            {/* Resultado de la IA */}
            <div className="mt-6">
                {error && <div className="text-red-500 bg-red-100 p-3 rounded-lg border border-red-200">{error}</div>}
                {loading && <div className="flex justify-center py-4"><Spinner /></div>}
                {result && (
                    <div className="bg-green-50 border border-green-200 p-4 rounded-lg shadow-inner whitespace-pre-wrap">
                        <h3 className="text-lg font-semibold mb-2 text-green-700">Resultado de la IA:</h3>
                        {result}
                    </div>
                )}
            </div>
        </div>
    );
};


const SkinAnalysisTool = () => {
    const [imageFile, setImageFile] = useState(null);
    const [imagePreviewUrl, setImagePreviewUrl] = useState(DEFAULT_IMAGE_URL);
    const [notes, setNotes] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);

    const handleImageChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            setImageFile(file);
            setImagePreviewUrl(URL.createObjectURL(file));
        }
    };

    const analyzeSkinImage = async () => {
        if (!imageFile) { setError("Por favor, sube una imagen de tu rostro."); return; }
        setError(null);
        setResult(null);
        setLoading(true);

        try {
            const base64Image = await fileToBase64(imageFile);
            
            const systemPrompt = "Eres un dermoconsejero experto. Analiza la imagen del rostro proporcionada por el usuario. Evalúa la textura, luminosidad y el tipo de rostro (ej. óvalo, cuadrado). Proporciona consejos específicos de cuidado de la piel y maquillaje que se adapten a las mejoras visibles o a las áreas de enfoque, y al tipo de rostro. Considera las notas del usuario si existen. Responde en español y en formato Markdown.";
            
            let userQuery = "Analiza esta imagen de mi rostro para mejoras en la piel y consejos de belleza. ";
            if (notes) {
                userQuery += `Notas adicionales: ${notes}.`;
            } else {
                userQuery += "No hay notas adicionales.";
            }

            const response = await generateMultimodalContent(systemPrompt, userQuery, base64Image);
            setResult(response);

        } catch (e) {
            console.error("Error en el análisis de piel:", e);
            setError(`Error al analizar la piel: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="bg-white p-6 rounded-xl shadow-2xl">
            <h2 className="text-2xl font-bold mb-4 text-pink-700 border-b pb-2">Diario de Piel y Rostro IA</h2>
            <p className="mb-4 text-gray-600">Sube una foto de tu rostro para obtener un análisis de progreso y consejos personalizados de cuidado de la piel y belleza.</p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                {/* Columna de Imagen */}
                <div className="md:col-span-1 flex flex-col items-center p-4 border rounded-lg bg-gray-50">
                    <img src={imagePreviewUrl} alt="Vista previa del rostro" className="w-32 h-32 object-cover rounded-full mb-3 border-4 border-pink-300 shadow-lg" />
                    <input
                        type="file"
                        accept="image/png, image/jpeg"
                        onChange={handleImageChange}
                        className="text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-pink-50 file:text-pink-700 hover:file:bg-pink-100"
                    />
                </div>

                {/* Columna de Notas y Botón */}
                <div className="md:col-span-2 flex flex-col justify-between">
                    <textarea
                        placeholder="Notas sobre tu rutina de hoy o cambios que quieres que la IA observe..."
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        className="w-full p-3 border border-gray-300 rounded-lg mb-4 flex-grow h-full"
                        rows={5}
                    ></textarea>
                     <button
                        onClick={analyzeSkinImage}
                        disabled={loading || !imageFile}
                        className="bg-pink-500 text-white p-3 rounded-lg font-semibold hover:bg-pink-600 transition duration-150 disabled:bg-gray-400 shadow-md"
                    >
                        {loading ? <Spinner /> : "Analizar Rostro y Dar Consejos"}
                    </button>
                </div>
            </div>

            {/* Resultado de la IA */}
            <div className="mt-6">
                {error && <div className="text-red-500 bg-red-100 p-3 rounded-lg border border-red-200">{error}</div>}
                {loading && <div className="flex justify-center py-4"><Spinner /></div>}
                {result && (
                    <div className="bg-pink-50 border border-pink-200 p-4 rounded-lg shadow-inner whitespace-pre-wrap">
                        <h3 className="text-lg font-semibold mb-2 text-pink-700">Informe de Belleza IA:</h3>
                        {result}
                    </div>
                )}
            </div>
        </div>
    );
};


// --- COMPONENTE PRINCIPAL APP ---

const App = () => {
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [userId, setUserId] = useState(null);
    const [weightData, setWeightData] = useState([]);
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [activeTab, setActiveTab] = useState('home');

    // 1. Inicialización de Firebase y Autenticación
    useEffect(() => {
        if (!firebaseConfig.apiKey) {
            console.error("Firebase no está configurado. La aplicación no funcionará correctamente.");
            setIsAuthReady(true); // Permitir que la UI cargue aunque sin conexión a DB
            return;
        }

        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const authentication = getAuth(app);
            
            setDb(firestore);
            setAuth(authentication);
            dbContext.app = app;
            dbContext.db = firestore;
            dbContext.auth = authentication;

            const authenticate = async () => {
                // Usar token personalizado si está disponible, sino autenticación anónima
                try {
                    if (initialAuthToken) {
                        await signInWithCustomToken(authentication, initialAuthToken);
                    } else {
                        await signInAnonymously(authentication);
                    }
                } catch (e) {
                    console.error("Error en signInWithCustomToken, intentando anónimo:", e);
                    // Fallback a anónimo si falla el token (permisos/expiración)
                    await signInAnonymously(authentication);
                }
            };

            // Asegura que el estado de autenticación se maneje
            const unsubscribe = onAuthStateChanged(authentication, (user) => {
                let currentUserId;
                if (user) {
                    currentUserId = user.uid;
                } else {
                    // Esto solo debería pasar si la autenticación falla por completo, usamos un UUID
                    currentUserId = crypto.randomUUID();
                }
                setUserId(currentUserId);
                dbContext.userId = currentUserId;
                // NOTA: isAuthReady se establece una vez que onAuthStateChanged ha dado un resultado, 
                // asegurando que tenemos un userId (ya sea real o fallback).
                setIsAuthReady(true);
            });

            // Llama a authenticate y maneja el estado
            authenticate().catch(e => {
                console.error("Error al completar la autenticación, UI cargará con UUID:", e);
                // Asegurar que setIsAuthReady se llama incluso si falla.
                setIsAuthReady(true);
            });

            return () => unsubscribe();

        } catch (e) {
            console.error("Error al inicializar Firebase:", e);
            setIsAuthReady(true);
        }
    }, []);

    // 2. Suscripción a datos de peso (Firestore Listener)
    useEffect(() => {
        // CORRECCIÓN DE ERRORES DE PERMISOS: Añadimos una comprobación estricta para asegurar
        // que la autenticación ha finalizado y el usuario (auth.currentUser) existe antes 
        // de intentar configurar el listener de Firestore.

        if (!db || !userId || !isAuthReady || !auth || !auth.currentUser) {
            console.log("Listener skip: DB, UserID, AuthReady, o currentUser no listos.");
            return;
        }
        
        // El userId ya está sincronizado con el user.uid de onAuthStateChanged
        const authenticatedUserId = userId; 

        console.log(`Setting up listener for user: ${authenticatedUserId}`);
        
        // Path para datos privados: /artifacts/{appId}/users/{userId}/{collectionName}
        const weightsRef = collection(db, `artifacts/${appId}/users/${authenticatedUserId}/weights`);
        // Se mantiene la consulta sin orderBy
        const q = query(weightsRef); 

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const weights = [];
            snapshot.forEach((doc) => {
                weights.push(doc.data());
            });
            // Ordenamos los datos en la memoria del cliente (Javascript)
            setWeightData(weights.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)));
        }, (error) => {
            // Este es el manejador de errores que capturó el error de permisos.
            // Lo logueamos pero evitamos un crash completo de la app.
            console.error("Error al escuchar los datos de peso:", error);
            setWeightData([]);
        });

        return () => unsubscribe();
    }, [db, userId, isAuthReady, auth]); // Dependencias estrictas: auth added

    const handleNewWeightRecord = useCallback((newWeight) => {
        // La suscripción a onSnapshot se encargará de actualizar weightData.
        console.log("Nuevo peso registrado:", newWeight);
    }, []);
    

    const renderContent = () => {
        if (!isAuthReady) {
            return (
                <div className="text-center p-10">
                    <Spinner />
                    <p className="mt-4 text-gray-600">Cargando aplicación y autenticando usuario...</p>
                </div>
            );
        }
        
        switch (activeTab) {
            case 'home':
                return (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6">
                        <RecordWeight db={db} userId={userId} onRecord={handleNewWeightRecord} />
                        <WeightHistory weightData={weightData} />
                        <div className="lg:col-span-2">
                           <AiTools weightData={weightData} />
                        </div>
                    </div>
                );
            case 'skin':
                return (
                    <div className="p-6">
                        <SkinAnalysisTool />
                    </div>
                );
            default:
                return null;
        }
    };

    return (
        <div className="min-h-screen bg-gray-100 font-sans">
            <header className="bg-white shadow-md p-4 flex justify-between items-center">
                <h1 className="text-3xl font-extrabold text-indigo-800">
                    Health IA Tracker
                </h1>
                <div className="flex space-x-4">
                    <button
                        onClick={() => setActiveTab('home')}
                        className={`py-2 px-4 rounded-lg font-medium transition duration-150 
                            ${activeTab === 'home' 
                                ? 'bg-indigo-600 text-white shadow-lg' 
                                : 'text-indigo-600 hover:bg-indigo-50'}`
                        }
                    >
                        Registro & Nutrición
                    </button>
                    <button
                        onClick={() => setActiveTab('skin')}
                        className={`py-2 px-4 rounded-lg font-medium transition duration-150 
                            ${activeTab === 'skin' 
                                ? 'bg-pink-600 text-white shadow-lg' 
                                : 'text-pink-600 hover:bg-pink-50'}`
                        }
                    >
                        Diario de Piel
                    </button>
                </div>
            </header>

            <main className="max-w-4xl mx-auto py-8">
                {renderContent()}
            </main>

            <footer className="text-center p-4 text-sm text-gray-500 border-t mt-8">
                ID de Usuario: <span className="font-mono text-xs break-all">{userId || 'Cargando...'}</span> | App ID: {appId}
            </footer>
        </div>