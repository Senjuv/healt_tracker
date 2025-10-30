import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { 
    getAuth, signInAnonymously, signInWithCustomToken, 
    onAuthStateChanged 
} from 'firebase/auth';
import { 
    getFirestore, doc, setDoc, 
    onSnapshot, collection, query, 
} from 'firebase/firestore';

// --- CONFIGURACIÓN DE FIREBASE Y VARIABLES GLOBALES ---
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-health-app';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

const API_MODEL_TEXT = "gemini-2.5-flash-preview-09-2025";
const API_URL_TEXT = `https://generativelanguage.googleapis.com/v1beta/models/${API_MODEL_TEXT}:generateContent?key=`;

const DEFAULT_IMAGE_URL = "https://placehold.co/300x200/222/fff?text=Carga+tu+Imagen";

// --- INICIALIZACIÓN DE FIREBASE ---
let app;
let db;
let auth;
if (Object.keys(firebaseConfig).length > 0) {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
}

// Función para simular la lógica de exponential backoff y fetch
const fetchWithBackoff = async (url, options) => {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                // Manejar error de HTTP
                const errorBody = await response.json();
                throw new Error(`HTTP error! status: ${response.status}. Details: ${JSON.stringify(errorBody)}`);
            }
            return response;
        } catch (error) {
            lastError = error;
            console.error(`Attempt ${attempt + 1} failed:`, error.message);
            if (attempt < 2) {
                // Esperar 2^attempt segundos
                const delay = Math.pow(2, attempt) * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw new Error(`Failed after multiple retries: ${lastError.message}`);
};


// --- COMPONENTES DE LA APLICACIÓN ---

// Componente para la entrada de peso y el gráfico
const WeightTracker = ({ userId, db, isAuthReady, weightData }) => {
    const [currentWeight, setCurrentWeight] = useState('');
    const [saveMessage, setSaveMessage] = useState('');

    const handleSaveWeight = async () => {
        if (!db || !userId || !currentWeight) {
            setSaveMessage('Error: Faltan datos de usuario o peso.');
            return;
        }
        
        const weightValue = parseFloat(currentWeight);
        if (isNaN(weightValue) || weightValue <= 0) {
            setSaveMessage('Por favor, ingresa un peso válido.');
            return;
        }

        try {
            const timestamp = new Date().toISOString();
            // Usamos el timestamp como ID de documento para asegurar un orden único y natural
            const docRef = doc(db, `artifacts/${appId}/users/${userId}/weights`, timestamp);
            
            await setDoc(docRef, {
                weight: weightValue,
                timestamp: timestamp,
                date: new Date().toLocaleDateString('es-ES'),
            });
            
            setSaveMessage('¡Peso guardado con éxito!');
            setCurrentWeight('');
            setTimeout(() => setSaveMessage(''), 3000);
        } catch (error) {
            console.error("Error al guardar el peso:", error);
            setSaveMessage(`Error al guardar: ${error.message}`);
        }
    };

    // La data ya viene ordenada del useEffect principal
    const sortedData = weightData; 

    const totalEntries = sortedData.length;
    const initialWeight = totalEntries > 0 ? sortedData[0].weight : 0;
    const latestWeight = totalEntries > 0 ? sortedData[totalEntries - 1].weight : 0;
    const change = latestWeight - initialWeight;

    return (
        <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100 mb-8">
            <h2 className="text-2xl font-bold text-indigo-800 mb-4 border-b pb-2">Registro de Peso</h2>
            
            <div className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-6 items-start sm:items-end mb-6">
                <div className="flex-1 w-full">
                    <label htmlFor="weight" className="block text-sm font-medium text-gray-700">
                        Peso Actual (kg):
                    </label>
                    <input
                        type="number"
                        id="weight"
                        value={currentWeight}
                        onChange={(e) => setCurrentWeight(e.target.value)}
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-3 focus:ring-indigo-500 focus:border-indigo-500"
                        placeholder="Ej. 75.5"
                        min="1"
                    />
                </div>
                <button
                    onClick={handleSaveWeight}
                    disabled={!isAuthReady || !currentWeight}
                    className="w-full sm:w-auto px-6 py-3 bg-indigo-600 text-white font-semibold rounded-lg shadow-md hover:bg-indigo-700 transition duration-150 disabled:opacity-50"
                >
                    Guardar Peso
                </button>
            </div>
            
            {saveMessage && (
                <p className={`text-sm font-semibold ${saveMessage.includes('Error') ? 'text-red-500' : 'text-green-600'} mt-2`}>
                    {saveMessage}
                </p>
            )}

            <div className="mt-6 p-4 bg-indigo-50 rounded-lg">
                <h3 className="text-lg font-semibold text-indigo-700 mb-3">Tu Progreso</h3>
                <div className="flex justify-between items-center text-sm font-medium">
                    <span>Entradas Totales:</span>
                    <span className="text-gray-900">{totalEntries}</span>
                </div>
                <div className="flex justify-between items-center text-sm font-medium mt-1">
                    <span>Peso Inicial:</span>
                    <span className="text-gray-900">{initialWeight > 0 ? `${initialWeight} kg` : 'N/A'}</span>
                </div>
                <div className="flex justify-between items-center text-sm font-medium mt-1">
                    <span>Peso Más Reciente:</span>
                    <span className="text-gray-900">{latestWeight > 0 ? `${latestWeight} kg` : 'N/A'}</span>
                </div>
                <div className="flex justify-between items-center text-sm font-medium mt-2 pt-2 border-t border-indigo-200">
                    <span>Cambio Total:</span>
                    <span className={`font-bold ${change > 0 ? 'text-red-500' : change < 0 ? 'text-green-600' : 'text-gray-500'}`}>
                        {change > 0 ? `+${change.toFixed(1)} kg` : change.toFixed(1) + ' kg'}
                    </span>
                </div>
            </div>
        </div>
    );
};

// Función de generación de IA
const generateAIResponse = async (currentPrompt, imageBase64, systemInstruction, enableSearch, setAiResponse, setIsLoading) => {
    setIsLoading(true);
    setAiResponse(null);

    try {
        const apiKey = ""; 
        const apiUrl = `${API_URL_TEXT}${apiKey}`;

        const parts = [{ text: currentPrompt }];
        if (imageBase64) {
            parts.push({
                inlineData: {
                    mimeType: "image/png", // Asumiendo que vamos a manejar PNG para consistencia
                    data: imageBase64
                }
            });
        }

        const payload = {
            contents: [{ parts }],
            systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
            tools: enableSearch ? [{ "google_search": {} }] : undefined,
        };

        const response = await fetchWithBackoff(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "Error: No se pudo obtener respuesta de la IA.";
        setAiResponse(text);

    } catch (error) {
        console.error("Error en la llamada a la API de Gemini:", error);
        setAiResponse(`Error al procesar la solicitud: ${error.message}`);
    } finally {
        setIsLoading(false);
    }
};


// Componente para las herramientas de IA
const AITools = ({ userId, weightData, db }) => {
    const [aiResponse, setAiResponse] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [currentTool, setCurrentTool] = useState('mealPlan');
    const [prompt, setPrompt] = useState('');
    const [base64Image, setBase64Image] = useState(null);
    const [imagePreview, setImagePreview] = useState(DEFAULT_IMAGE_URL);

    // Función para manejar la subida de imagen y convertirla a Base64
    const handleImageChange = (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                setBase64Image(base64);
                setImagePreview(reader.result);
            };
            reader.readAsDataURL(file);
        } else {
            setBase64Image(null);
            setImagePreview(DEFAULT_IMAGE_URL);
        }
    };

    // Función principal para manejar el envío de la herramienta
    const handleSubmit = async (e) => {
        e.preventDefault();
        
        let systemInstruction = "";
        let finalPrompt = "";
        let enableSearch = false;
        let imageToSend = null;

        switch (currentTool) {
            case 'mealPlan':
                systemInstruction = "Actúa como un dietista y planificador de comidas profesional. Genera un plan semanal conciso basado en la meta proporcionada. La respuesta debe ser solo texto Markdown, sin preámbulo.";
                finalPrompt = `Genera un plan de comidas de 7 días (desayuno, almuerzo, cena) para esta meta: ${prompt}.`;
                break;
            case 'photoAnalysis':
                if (!base64Image) {
                    setAiResponse("Por favor, sube una imagen de tu plato para el análisis nutricional.");
                    return;
                }
                systemInstruction = "Actúa como un analista nutricional. Basándote en la imagen de la comida, haz una estimación de los ingredientes principales, calorías aproximadas y una breve nota sobre su balance nutricional. Responde con un formato de lista en Markdown.";
                finalPrompt = "Analiza esta comida y proporciona una estimación nutricional.";
                imageToSend = base64Image;
                break;
            case 'symptomCheck':
                systemInstruction = "Actúa como un asistente de salud informativa. Analiza los síntomas proporcionados y ofrece información general sobre posibles causas comunes y recomendaciones de estilo de vida. ADVERTENCIA: Nunca proporciones diagnósticos médicos. La respuesta debe ser cautelosa y en formato de lista en Markdown.";
                finalPrompt = `Analiza los siguientes síntomas: ${prompt}`;
                enableSearch = true;
                break;
            case 'progressTips':
                systemInstruction = "Actúa como un entrenador personal y motivador. Analiza el historial de peso proporcionado y la meta del usuario para dar 3 consejos de progreso personalizados y un mensaje de motivación. La respuesta debe ser en formato de lista Markdown.";
                
                const progressSummary = weightData.length > 0
                    ? `El usuario tiene ${weightData.length} registros. Su peso inicial fue ${weightData[0].weight}kg (en ${new Date(weightData[0].timestamp).toLocaleDateString('es-ES')}) y el último peso es ${weightData[weightData.length - 1].weight}kg (en ${new Date(weightData[weightData.length - 1].timestamp).toLocaleDateString('es-ES')}).`
                    : "No hay historial de peso disponible. La meta es: " + prompt;

                finalPrompt = `Analiza este historial y proporciona consejos de progreso basados en la meta: ${prompt}. Historial: ${progressSummary}`;
                break;
            default:
                return;
        }

        await generateAIResponse(finalPrompt, imageToSend, systemInstruction, enableSearch, setAiResponse, setIsLoading);
    };

    // Renderizado del formulario de la herramienta activa
    const renderForm = () => {
        if (currentTool === 'photoAnalysis') {
            return (
                <div className="space-y-4">
                    <label className="block text-sm font-medium text-gray-700">
                        Sube una foto de tu plato para el análisis nutricional:
                    </label>
                    <input
                        type="file"
                        accept="image/png, image/jpeg"
                        onChange={handleImageChange}
                        className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
                    />
                    <img 
                        src={imagePreview} 
                        alt="Previsualización de la comida" 
                        className="w-full h-48 object-cover rounded-lg shadow-inner border border-gray-200"
                    />
                    <p className="text-sm text-gray-500">La IA analizará la imagen para darte un desglose nutricional estimado.</p>
                </div>
            );
        }

        const placeholderText = {
            mealPlan: 'Ej: "Quiero ganar 5kg de músculo en 3 meses" o "Necesito un plan para perder grasa".',
            symptomCheck: 'Ej: "Dolor de cabeza leve, fatiga y dolor de garganta".',
            progressTips: 'Ej: "Quiero mantener mi peso actual" o "Mi meta es correr un maratón".',
        };

        const titleText = {
            mealPlan: 'Tu Meta Nutricional:',
            symptomCheck: 'Tus Síntomas (No es Diagnóstico Médico):',
            progressTips: 'Tu Próxima Meta o Desafío:',
        };

        return (
            <div className="space-y-4">
                <label htmlFor="prompt" className="block text-sm font-medium text-gray-700">
                    {titleText[currentTool]}
                </label>
                <textarea
                    id="prompt"
                    rows="4"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-3 focus:ring-indigo-500 focus:border-indigo-500"
                    placeholder={placeholderText[currentTool]}
                    required
                ></textarea>
            </div>
        );
    };

    return (
        <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100">
            <h2 className="text-2xl font-bold text-indigo-800 mb-4 border-b pb-2">Herramientas de Salud con IA</h2>
            
            <div className="flex flex-wrap gap-2 mb-6">
                {['mealPlan', 'photoAnalysis', 'symptomCheck', 'progressTips'].map((tool) => (
                    <button
                        key={tool}
                        onClick={() => {
                            setCurrentTool(tool);
                            setAiResponse(null);
                            setPrompt('');
                            setBase64Image(null);
                            setImagePreview(DEFAULT_IMAGE_URL);
                        }}
                        className={`px-4 py-2 text-sm font-semibold rounded-full transition duration-150 
                            ${currentTool === tool 
                                ? 'bg-indigo-500 text-white shadow-md' 
                                : 'bg-gray-100 text-gray-700 hover:bg-indigo-50'
                            }`
                        }
                    >
                        {tool === 'mealPlan' && 'Planificador de Comidas'}
                        {tool === 'photoAnalysis' && 'Análisis de Foto'}
                        {tool === 'symptomCheck' && 'Analizador de Síntomas'}
                        {tool === 'progressTips' && 'Consejos de Progreso'}
                    </button>
                ))}
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
                {renderForm()}
                <button
                    type="submit"
                    disabled={isLoading || (currentTool !== 'photoAnalysis' && !prompt) || (currentTool === 'photoAnalysis' && !base64Image)}
                    className="w-full px-6 py-3 bg-green-500 text-white font-semibold rounded-lg shadow-md hover:bg-green-600 transition duration-150 disabled:opacity-50"
                >
                    {isLoading ? (
                        <span className="flex items-center justify-center">
                            <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            Analizando...
                        </span>
                    ) : (
                        'Consultar a la IA'
                    )}
                </button>
            </form>
            
            {aiResponse && (
                <div className="mt-8 p-4 bg-gray-50 rounded-lg border border-gray-200">
                    <h3 className="text-xl font-semibold text-gray-800 mb-3">Respuesta de la IA</h3>
                    <div className="prose max-w-none text-gray-700">
                        {/* El uso de <pre> es simple pero efectivo para mostrar la respuesta en Markdown */}
                        <pre className="whitespace-pre-wrap font-sans text-sm">{aiResponse}</pre>
                    </div>
                </div>
            )}
        </div>
    );
};

// Componente de Diario de Piel (Skin)
const SkinJournal = () => {
    const [aiResponse, setAiResponse] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [base64Image, setBase64Image] = useState(null);
    const [imagePreview, setImagePreview] = useState(DEFAULT_IMAGE_URL);
    const [prompt, setPrompt] = useState('');

    const handleImageChange = (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                setBase64Image(base64);
                setImagePreview(reader.result);
            };
            reader.readAsDataURL(file);
        } else {
            setBase64Image(null);
            setImagePreview(DEFAULT_IMAGE_URL);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!base64Image) {
            setAiResponse("Por favor, sube una foto de tu rostro para el análisis.");
            return;
        }
        
        const systemInstruction = "Actúa como un experto en cuidado de la piel (skincare). Analiza la imagen del rostro proporcionada, identifica problemas comunes (como acné, enrojecimiento, sequedad o brillo) y ofrece una rutina básica de cuidado con sugerencias de ingredientes clave. La respuesta debe ser estructurada en Markdown (Análisis, Rutina Sugerida, Ingredientes Clave).";
        const finalPrompt = `Analiza la imagen del rostro. El usuario proporciona la siguiente información adicional: ${prompt || 'Ninguna'}. Genera el análisis de la piel.`;
        
        await generateAIResponse(finalPrompt, base64Image, systemInstruction, false, setAiResponse, setIsLoading);
    };

    return (
        <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100">
            <h2 className="text-2xl font-bold text-pink-700 mb-4 border-b pb-2">Analizador de Rostro con IA</h2>
            <p className="text-gray-600 mb-6">Sube una foto de tu rostro (con buena iluminación) y describe tu rutina actual o preocupaciones para recibir un análisis de piel personalizado y sugerencias de rutina.</p>

            <form onSubmit={handleSubmit} className="space-y-6">
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label htmlFor="skinImage" className="block text-sm font-medium text-gray-700">
                            Sube una foto de tu rostro:
                        </label>
                        <input
                            type="file"
                            id="skinImage"
                            accept="image/png, image/jpeg"
                            onChange={handleImageChange}
                            className="mt-1 block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-pink-50 file:text-pink-700 hover:file:bg-pink-100"
                        />
                        <img 
                            src={imagePreview} 
                            alt="Previsualización del rostro" 
                            className="w-full h-64 object-cover rounded-lg shadow-inner border border-gray-200 mt-4"
                        />
                    </div>
                    <div>
                        <label htmlFor="skinPrompt" className="block text-sm font-medium text-gray-700">
                            Describe tu rutina o preocupaciones (opcional):
                        </label>
                        <textarea
                            id="skinPrompt"
                            rows="7"
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-3 focus:ring-pink-500 focus:border-pink-500"
                            placeholder="Ej: Tengo piel grasa y propensa al acné. Actualmente uso un limpiador y un hidratante simple."
                        ></textarea>
                    </div>
                </div>

                <button
                    type="submit"
                    disabled={isLoading || !base64Image}
                    className="w-full px-6 py-3 bg-pink-600 text-white font-semibold rounded-lg shadow-md hover:bg-pink-700 transition duration-150 disabled:opacity-50"
                >
                    {isLoading ? (
                        <span className="flex items-center justify-center">
                            <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            Analizando Rostro...
                        </span>
                    ) : (
                        'Obtener Análisis de Piel con IA'
                    )}
                </button>
            </form>

            {aiResponse && (
                <div className="mt-8 p-4 bg-pink-50 rounded-lg border border-pink-200">
                    <h3 className="text-xl font-semibold text-pink-800 mb-3">Diagnóstico y Rutina Sugerida</h3>
                    <div className="prose max-w-none text-gray-700">
                        <pre className="whitespace-pre-wrap font-sans text-sm">{aiResponse}</pre>
                    </div>
                </div>
            )}
        </div>
    );
};


// --- COMPONENTE PRINCIPAL (APP) ---

const App = () => {
    const [dbInstance, setDbInstance] = useState(null);
    const [authInstance, setAuthInstance] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [activeTab, setActiveTab] = useState('home');
    const [weightData, setWeightData] = useState([]);

    // 1. Inicialización de Firebase y Autenticación
    useEffect(() => {
        if (!app || !auth || !db) return;

        setDbInstance(db);
        setAuthInstance(auth);

        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (user) {
                setUserId(user.uid);
                setIsAuthReady(true);
            } else if (initialAuthToken) {
                try {
                    // Intenta iniciar sesión con el token personalizado de Canvas
                    const userCredential = await signInWithCustomToken(auth, initialAuthToken);
                    setUserId(userCredential.user.uid);
                } catch (error) {
                    console.error("Error al iniciar sesión con token personalizado:", error);
                    // Si falla, cae a anónimo
                    await signInAnonymously(auth);
                } finally {
                    setIsAuthReady(true);
                }
            } else {
                // Si no hay token personalizado, usa anónimo
                try {
                    const userCredential = await signInAnonymously(auth);
                    setUserId(userCredential.user.uid);
                } catch (error) {
                    console.error("Error al iniciar sesión anónimamente:", error);
                    setUserId('anonymous-error');
                } finally {
                    setIsAuthReady(true);
                }
            }
        });

        return () => unsubscribe();
    }, []);

    // 2. Escucha de Datos de Firestore (Peso)
    useEffect(() => {
        // Ejecutar solo si Firebase está listo, la autenticación ha finalizado y tenemos un userId
        if (!dbInstance || !userId || !isAuthReady || !authInstance?.currentUser) {
            return;
        }

        const q = query(
            collection(dbInstance, `artifacts/${appId}/users/${userId}/weights`)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const data = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            
            // Ordenar los datos en el cliente por timestamp para que el progreso sea correcto
            const sortedData = data.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            
            setWeightData(sortedData);
        }, (error) => {
            console.error("Error al escuchar los datos de peso:", error);
        });

        return () => unsubscribe();
    }, [dbInstance, userId, isAuthReady, authInstance]);


    const renderContent = () => {
        const commonProps = { userId, db: dbInstance, isAuthReady };

        if (activeTab === 'home') {
            return (
                <div className="space-y-8">
                    <WeightTracker {...commonProps} weightData={weightData} />
                    <AITools {...commonProps} weightData={weightData} />
                </div>
            );
        } else if (activeTab === 'skin') {
            return <SkinJournal {...commonProps} />;
        }
        return null;
    };

    return (
        <div className="min-h-screen bg-gray-50 font-sans">
            <header className="bg-white shadow-md p-4 sticky top-0 z-10">
                <div className="max-w-4xl mx-auto flex flex-col sm:flex-row justify-between items-center space-y-4 sm:space-y-0">
                    <h1 className="text-2xl font-extrabold text-gray-800">
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
                </div>
            </header>

            <main className="max-w-4xl mx-auto py-8 px-4 sm:px-0">
                {renderContent()}
            </main>

            <footer className="text-center p-4 text-sm text-gray-500 border-t mt-8">
                ID de Usuario: <span className="font-mono text-xs break-all">{userId || 'Cargando...'}</span> | App ID: {appId}
            </footer>
        </div>
    );
};

// --- LÓGICA DE MONTAJE PARA EL ENTORNO CANVAS/React ---
// Exportamos el componente principal por defecto. El entorno se encarga de montarlo.
export default App;