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

// --- CONFIGURACIÓN DE FIREBASE Y VARIABLES GLOBALES (Necesarias para el entorno) ---
// La configuración se obtiene de variables de entorno del Canvas.
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-health-app';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

const API_MODEL_TEXT = "gemini-2.5-flash-preview-09-2025";
const API_URL_TEXT = `https://generativelanguage.googleapis.com/v1beta/models/${API_MODEL_TEXT}:generateContent?key=`;

// URL para el placeholder de carga de imagen/documento
const DEFAULT_IMAGE_URL = "https://placehold.co/400x300/e0e7ff/6366f1?text=Subir+Imagen";

// --- UTILIDADES ---

// Función de retardo exponencial para reintentos de API
const fetchWithBackoff = async (url, options, retries = 3, delay = 1000) => {
    try {
        const response = await fetch(url, options);
        if (response.status === 429 && retries > 0) {
            console.warn(`429 Rate Limit. Retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithBackoff(url, options, retries - 1, delay * 2);
        }
        if (!response.ok) {
             const errorBody = await response.text();
             throw new Error(`API call failed: ${response.status} - ${errorBody}`);
        }
        return response;
    } catch (error) {
        if (retries > 0 && error.message.includes('API call failed: 5')) { // Retry on 5xx errors too
            console.warn(`Server Error. Retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithBackoff(url, options, retries - 1, delay * 2);
        }
        throw error;
    }
};


// Hook para la generación de contenido con la API de Gemini
const useGeminiGenerator = () => {
    const [isLoading, setIsLoading] = useState(false);
    const [aiResponse, setAiResponse] = useState(null);

    const runGeneration = async ({ prompt, base64Image, systemInstruction, enableSearch = false }) => {
        if (!prompt) return;

        setIsLoading(true);
        setAiResponse(null);

        try {
            const apiKey = ""; 
            const apiUrl = `${API_URL_TEXT}${apiKey}`;

            const parts = [{ text: prompt }];
            if (base64Image) {
                // Asumiendo que base64Image incluye el prefijo mimeType (e.g., data:image/png;base64,...)
                // Si solo es el data puro, ajustar mimeType. Aquí asumimos que es data:image/png;base64,...
                const [mimeTypePrefix, base64Data] = base64Image.split(',');
                const mimeTypeMatch = mimeTypePrefix.match(/data:(.*?);base64/);
                const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : "image/jpeg"; // Default to jpeg if parsing fails

                parts.push({
                    inlineData: {
                        mimeType: mimeType, 
                        data: base64Data
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
    return { runGeneration, isLoading, aiResponse, setAiResponse, setIsLoading };
};


// Hook para la gestión de Firebase (Auth y Firestore)
const useFirebase = () => {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    useEffect(() => {
        try {
            const app = initializeApp(firebaseConfig);
            const firestoreDb = getFirestore(app);
            const firebaseAuth = getAuth(app);

            setDb(firestoreDb);
            setAuth(firebaseAuth);

            // 1. Manejar autenticación
            const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
                if (user) {
                    setUserId(user.uid);
                    setIsAuthReady(true);
                } else if (initialAuthToken) {
                    try {
                        await signInWithCustomToken(firebaseAuth, initialAuthToken);
                    } catch (error) {
                        console.error("Error signing in with custom token:", error);
                        await signInAnonymously(firebaseAuth);
                        setUserId(firebaseAuth.currentUser?.uid || crypto.randomUUID());
                        setIsAuthReady(true);
                    }
                } else {
                    try {
                        await signInAnonymously(firebaseAuth);
                        setUserId(firebaseAuth.currentUser?.uid || crypto.randomUUID());
                        setIsAuthReady(true);
                    } catch (error) {
                        console.error("Error signing in anonymously:", error);
                        setUserId(crypto.randomUUID()); // Fallback if anonymous sign-in fails
                        setIsAuthReady(true);
                    }
                }
            });

            return () => unsubscribe();
        } catch (error) {
            console.error("Error initializing Firebase:", error);
            setIsAuthReady(true); // Treat as ready even on failure
        }
    }, []);

    return { db, auth, userId, isAuthReady };
};


// --- COMPONENTES DE VISTA ---

// 1. Registro y Nutrición (Pestaña 'home')
const HomeTracker = ({ db, userId, isAuthReady }) => {
    const { runGeneration, isLoading, aiResponse, setAiResponse, setIsLoading } = useGeminiGenerator();
    
    const [record, setRecord] = useState({ 
        mealDescription: '', 
        image: null, 
        base64Image: null 
    });
    const [history, setHistory] = useState([]);
    const [isSaving, setIsSaving] = useState(false);
    
    const [message, setMessage] = useState('');
    const [messageType, setMessageType] = useState(''); // success, error, info

    // 2. Carga de la imagen
    const handleImageChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            setRecord(prev => ({ ...prev, image: file }));
            const reader = new FileReader();
            reader.onloadend = () => {
                setRecord(prev => ({ ...prev, base64Image: reader.result }));
            };
            reader.readAsDataURL(file);
        }
    };

    // 3. Generar análisis de Nutrición
    const analyzeMeal = useCallback(async () => {
        if (!record.mealDescription && !record.base64Image) {
            setMessageType('error');
            setMessage('Por favor, describe tu comida o sube una imagen antes de analizar.');
            return;
        }

        setMessageType('info');
        setMessage('Generando análisis nutricional. Esto puede tardar unos segundos...');

        const prompt = record.mealDescription || "Analiza los alimentos en esta imagen y proporciona un resumen nutricional, incluyendo macronutrientes, calorías estimadas y sugerencias de mejora dietética.";
        const systemInstruction = "Eres un nutricionista IA experto. Tu tarea es analizar la descripción de la comida o la imagen provista por el usuario. Responde de forma amigable y concisa, utilizando viñetas (formato Markdown) para el desglose de nutrientes y calorías. Proporciona siempre sugerencias de mejora o un comentario positivo.";

        await runGeneration({ 
            prompt, 
            base64Image: record.base64Image, 
            systemInstruction 
        });

        setMessage(''); // Clear info message after generation starts or finishes
    }, [record.mealDescription, record.base64Image, runGeneration]);

    // 4. Guardar registro
    const saveRecord = async () => {
        if (!db || !userId) return;

        if (!record.mealDescription && !record.base64Image) {
            setMessageType('error');
            setMessage('Necesitas una descripción o una imagen para guardar el registro.');
            return;
        }

        setIsSaving(true);
        setMessageType('info');
        setMessage('Guardando registro...');

        // Prepara los datos a guardar (solo guardamos la base64 si existe, o un enlace si fuera una app real)
        const dataToSave = {
            description: record.mealDescription,
            analysis: aiResponse || "Análisis pendiente",
            timestamp: new Date().toISOString(),
            hasImage: !!record.base64Image
            // En una app real NO se guarda la base64, solo el link de Storage
            // Aquí lo simplificamos para la demo
        };

        try {
            const historyCollection = collection(db, `artifacts/${appId}/users/${userId}/nutrition_history`);
            await setDoc(doc(historyCollection), dataToSave); 
            
            // Limpiar formulario y respuesta AI después de guardar
            setRecord({ mealDescription: '', image: null, base64Image: null });
            setAiResponse(null);
            
            setMessageType('success');
            setMessage('¡Registro guardado exitosamente!');
        } catch (error) {
            console.error("Error saving record:", error);
            setMessageType('error');
            setMessage(`Error al guardar: ${error.message}`);
        } finally {
            setIsSaving(false);
            setTimeout(() => setMessage(''), 5000); // Clear message after 5 seconds
        }
    };

    // 5. Escuchar el historial en tiempo real
    useEffect(() => {
        if (!db || !isAuthReady || !userId) return;

        const historyCollection = collection(db, `artifacts/${appId}/users/${userId}/nutrition_history`);
        
        // Firestore query (sin orderBy para evitar errores de índice en Canvas)
        const q = query(historyCollection); 

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const records = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                timestamp: doc.data().timestamp ? new Date(doc.data().timestamp) : new Date()
            }));

            // Ordenar por timestamp localmente (descendente)
            records.sort((a, b) => b.timestamp - a.timestamp);
            setHistory(records);
        }, (error) => {
            console.error("Error listening to history:", error);
            setMessageType('error');
            setMessage(`Error al cargar historial: ${error.message}`);
        });

        return () => unsubscribe();
    }, [db, userId, isAuthReady]); // Dependencias para re-ejecutar el listener

    // 6. Componente de Renderizado de Mensajes
    const MessageDisplay = ({ msg, type }) => {
        if (!msg) return null;
        const colorClass = type === 'success' ? 'bg-green-100 text-green-700 border-green-400'
                         : type === 'error' ? 'bg-red-100 text-red-700 border-red-400'
                         : 'bg-blue-100 text-blue-700 border-blue-400';
        return (
            <div className={`p-3 rounded-lg border-l-4 font-medium mb-4 ${colorClass}`}>
                {msg}
            </div>
        );
    };

    return (
        <div className="space-y-8">
            <MessageDisplay msg={message} type={messageType} />

            {/* Formulario de Nuevo Registro */}
            <div className="bg-white p-6 rounded-xl shadow-lg border border-indigo-100">
                <h2 className="text-2xl font-bold text-indigo-800 mb-6 flex items-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Nuevo Registro de Comida
                </h2>
                
                <div className="grid md:grid-cols-2 gap-6">
                    {/* Columna de Descripción */}
                    <div>
                        <label htmlFor="mealDescription" className="block text-sm font-medium text-gray-700 mb-2">
                            Describe tu comida (o déjalo vacío si subes imagen)
                        </label>
                        <textarea
                            id="mealDescription"
                            rows="4"
                            value={record.mealDescription}
                            onChange={(e) => setRecord(prev => ({ ...prev, mealDescription: e.target.value }))}
                            placeholder="Ej: Un tazón de avena con frutas, semillas de chía y un vaso de jugo de naranja."
                            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 transition duration-150"
                        />
                    </div>
                    
                    {/* Columna de Imagen */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Sube una Imagen
                        </label>
                        <div className="flex items-center space-x-4">
                            <input
                                type="file"
                                accept="image/*"
                                onChange={handleImageChange}
                                className="block w-full text-sm text-gray-500
                                    file:mr-4 file:py-2 file:px-4
                                    file:rounded-full file:border-0
                                    file:text-sm file:font-semibold
                                    file:bg-indigo-50 file:text-indigo-700
                                    hover:file:bg-indigo-100
                                "
                            />
                        </div>
                        <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
                            <img 
                                src={record.base64Image || DEFAULT_IMAGE_URL} 
                                alt="Vista previa de la comida" 
                                className="w-full h-48 object-cover" 
                            />
                        </div>
                    </div>
                </div>

                <div className="mt-6 flex justify-end space-x-4">
                    <button
                        onClick={analyzeMeal}
                        disabled={isLoading || isSaving}
                        className="flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-full shadow-md text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition duration-150 transform hover:scale-[1.02]"
                    >
                        {isLoading ? (
                            <svg className="animate-spin h-5 w-5 mr-3 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L12 20.25l2.25-3.25m-4.5 0H16.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        )}
                        {isLoading ? 'Analizando...' : 'Analizar Comida con IA'}
                    </button>
                    <button
                        onClick={saveRecord}
                        disabled={!aiResponse || isSaving || isLoading}
                        className="flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-full shadow-md text-white bg-green-500 hover:bg-green-600 disabled:opacity-50 transition duration-150 transform hover:scale-[1.02]"
                    >
                         {isSaving ? 'Guardando...' : 'Guardar Registro'}
                    </button>
                </div>
            </div>

            {/* Respuesta de la IA */}
            {aiResponse && (
                <div className="bg-indigo-50 p-6 rounded-xl shadow-inner border border-indigo-200">
                    <h3 className="text-xl font-bold text-indigo-700 mb-4 flex items-center">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor"><path d="M5 4a1 1 0 011-1h8a1 1 0 011 1v12a1 1 0 01-1 1H6a1 1 0 01-1-1V4zm4 11a1 1 0 102 0 1 1 0 00-2 0z" /></svg>
                        Análisis Nutricional de Gemini
                    </h3>
                    <div className="prose max-w-none text-gray-700 leading-relaxed" dangerouslySetInnerHTML={{ __html: aiResponse.replace(/\n/g, '<br />') }} />
                </div>
            )}

            {/* Historial */}
            <div className="bg-gray-50 p-6 rounded-xl shadow-lg border border-gray-200">
                <h2 className="text-2xl font-bold text-gray-800 mb-6 flex items-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    Historial de Comidas ({history.length})
                </h2>
                {history.length === 0 ? (
                    <p className="text-gray-500 italic">Aún no tienes registros guardados.</p>
                ) : (
                    <div className="space-y-4">
                        {history.map((item) => (
                            <div key={item.id} className="p-4 bg-white border border-gray-100 rounded-lg shadow-sm hover:shadow-md transition duration-150">
                                <p className="text-sm text-gray-500 mb-1">
                                    {item.timestamp.toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })} 
                                    {item.hasImage && <span className="ml-2 px-2 py-0.5 text-xs font-semibold rounded-full bg-indigo-100 text-indigo-800">Con Imagen</span>}
                                </p>
                                <p className="text-gray-900 font-semibold">{item.description || 'Comida sin descripción'}</p>
                                <div className="mt-2 text-sm text-gray-700 border-t pt-2 max-h-24 overflow-y-auto">
                                    <h4 className="font-medium text-indigo-600">Análisis:</h4>
                                    <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: item.analysis.replace(/\n/g, '<br />') }} />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

// 2. Diario de Piel (Pestaña 'skin')
const SkinJournal = ({ db, userId, isAuthReady }) => {
    const { runGeneration, isLoading, aiResponse, setAiResponse, setIsLoading } = useGeminiGenerator();
    
    const [skinRecord, setSkinRecord] = useState({ 
        notes: '', 
        base64Image: null,
        image: null
    });
    const [history, setHistory] = useState([]);
    const [isSaving, setIsSaving] = useState(false);
    
    const [message, setMessage] = useState('');
    const [messageType, setMessageType] = useState('');

    // 2. Carga de la imagen
    const handleImageChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            setSkinRecord(prev => ({ ...prev, image: file }));
            const reader = new FileReader();
            reader.onloadend = () => {
                setSkinRecord(prev => ({ ...prev, base64Image: reader.result }));
            };
            reader.readAsDataURL(file);
        }
    };

    // 3. Generar análisis de Piel
    const analyzeSkin = useCallback(async () => {
        if (!skinRecord.base64Image) {
            setMessageType('error');
            setMessage('Por favor, sube una imagen de tu piel para analizar.');
            return;
        }

        setMessageType('info');
        setMessage('Analizando la condición de la piel. Esto puede tardar unos segundos...');
        setAiResponse(null); // Clear previous analysis

        const prompt = `Analiza la condición de la piel en esta imagen. Evalúa el nivel de hidratación, presencia de acné, enrojecimiento, o cualquier otra condición notable. ${skinRecord.notes ? `Nota adicional del usuario: ${skinRecord.notes}` : ''}. Proporciona un breve resumen de la condición actual y una sugerencia de rutina de cuidado o ingrediente clave a considerar.`;
        const systemInstruction = "Eres un dermatólogo IA experto. Tu tarea es analizar la imagen de la piel provista por el usuario. Responde de forma profesional, concisa y utiliza viñetas (formato Markdown) para el desglose de hallazgos. Nunca diagnostiques o reemplaces a un médico; siempre incluye una advertencia al final de que solo son sugerencias cosméticas/rutinas.";

        await runGeneration({ 
            prompt, 
            base64Image: skinRecord.base64Image, 
            systemInstruction 
        });

        setMessage(''); // Clear info message
    }, [skinRecord.base64Image, skinRecord.notes, runGeneration]);

    // 4. Guardar registro
    const saveSkinRecord = async () => {
        if (!db || !userId) return;

        if (!skinRecord.base64Image) {
            setMessageType('error');
            setMessage('Necesitas una imagen para guardar el registro de la piel.');
            return;
        }

        setIsSaving(true);
        setMessageType('info');
        setMessage('Guardando diario...');

        const dataToSave = {
            notes: skinRecord.notes,
            analysis: aiResponse || "Análisis pendiente",
            timestamp: new Date().toISOString(),
            hasImage: true
        };

        try {
            const journalCollection = collection(db, `artifacts/${appId}/users/${userId}/skin_journal`);
            await setDoc(doc(journalCollection), dataToSave); 
            
            // Limpiar formulario y respuesta AI después de guardar
            setSkinRecord({ notes: '', image: null, base64Image: null });
            setAiResponse(null);
            
            setMessageType('success');
            setMessage('¡Registro de piel guardado exitosamente!');
        } catch (error) {
            console.error("Error saving skin record:", error);
            setMessageType('error');
            setMessage(`Error al guardar: ${error.message}`);
        } finally {
            setIsSaving(false);
            setTimeout(() => setMessage(''), 5000);
        }
    };

    // 5. Escuchar el historial en tiempo real
    useEffect(() => {
        if (!db || !isAuthReady || !userId) return;

        const journalCollection = collection(db, `artifacts/${appId}/users/${userId}/skin_journal`);
        
        const q = query(journalCollection); 

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const records = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                timestamp: doc.data().timestamp ? new Date(doc.data().timestamp) : new Date()
            }));

            records.sort((a, b) => b.timestamp - a.timestamp);
            setHistory(records);
        }, (error) => {
            console.error("Error listening to skin journal:", error);
            setMessageType('error');
            setMessage(`Error al cargar historial: ${error.message}`);
        });

        return () => unsubscribe();
    }, [db, userId, isAuthReady]);

    const MessageDisplay = ({ msg, type }) => {
        if (!msg) return null;
        const colorClass = type === 'success' ? 'bg-green-100 text-green-700 border-green-400'
                         : type === 'error' ? 'bg-red-100 text-red-700 border-red-400'
                         : 'bg-pink-100 text-pink-700 border-pink-400';
        return (
            <div className={`p-3 rounded-lg border-l-4 font-medium mb-4 ${colorClass}`}>
                {msg}
            </div>
        );
    };

    return (
        <div className="space-y-8">
            <MessageDisplay msg={message} type={messageType} />

            {/* Formulario de Nuevo Registro de Piel */}
            <div className="bg-white p-6 rounded-xl shadow-lg border border-pink-100">
                <h2 className="text-2xl font-bold text-pink-800 mb-6 flex items-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                    </svg>
                    Nuevo Registro del Diario de Piel
                </h2>
                
                <div className="grid md:grid-cols-2 gap-6">
                    {/* Columna de Imagen */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Sube una Imagen de tu Piel
                        </label>
                        <div className="flex items-center space-x-4">
                            <input
                                type="file"
                                accept="image/*"
                                onChange={handleImageChange}
                                className="block w-full text-sm text-gray-500
                                    file:mr-4 file:py-2 file:px-4
                                    file:rounded-full file:border-0
                                    file:text-sm file:font-semibold
                                    file:bg-pink-50 file:text-pink-700
                                    hover:file:bg-pink-100
                                "
                            />
                        </div>
                        <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
                            <img 
                                src={skinRecord.base64Image || DEFAULT_IMAGE_URL} 
                                alt="Vista previa de la piel" 
                                className="w-full h-48 object-cover" 
                            />
                        </div>
                    </div>

                     {/* Columna de Notas */}
                    <div>
                        <label htmlFor="skinNotes" className="block text-sm font-medium text-gray-700 mb-2">
                            Notas (¿Qué has notado hoy? ¿Nuevos productos?)
                        </label>
                        <textarea
                            id="skinNotes"
                            rows="4"
                            value={skinRecord.notes}
                            onChange={(e) => setSkinRecord(prev => ({ ...prev, notes: e.target.value }))}
                            placeholder="Ej: La piel se siente un poco más tirante después de la limpieza. Probé un nuevo sérum de vitamina C."
                            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-pink-500 focus:border-pink-500 transition duration-150"
                        />
                    </div>
                </div>

                <div className="mt-6 flex justify-end space-x-4">
                    <button
                        onClick={analyzeSkin}
                        disabled={isLoading || isSaving || !skinRecord.base64Image}
                        className="flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-full shadow-md text-white bg-pink-600 hover:bg-pink-700 disabled:opacity-50 transition duration-150 transform hover:scale-[1.02]"
                    >
                        {isLoading ? (
                            <svg className="animate-spin h-5 w-5 mr-3 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                        )}
                        {isLoading ? 'Analizando...' : 'Analizar Piel con IA'}
                    </button>
                    <button
                        onClick={saveSkinRecord}
                        disabled={!aiResponse || isSaving || isLoading || !skinRecord.base64Image}
                        className="flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-full shadow-md text-white bg-purple-500 hover:bg-purple-600 disabled:opacity-50 transition duration-150 transform hover:scale-[1.02]"
                    >
                         {isSaving ? 'Guardando...' : 'Guardar Diario'}
                    </button>
                </div>
            </div>

            {/* Respuesta de la IA */}
            {aiResponse && (
                <div className="bg-pink-50 p-6 rounded-xl shadow-inner border border-pink-200">
                    <h3 className="text-xl font-bold text-pink-700 mb-4 flex items-center">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h.01a1 1 0 100-2H10V9a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                        Diagnóstico IA (Sugerencias Cosméticas)
                    </h3>
                    <div className="prose max-w-none text-gray-700 leading-relaxed" dangerouslySetInnerHTML={{ __html: aiResponse.replace(/\n/g, '<br />') }} />
                    <p className="mt-4 text-xs text-red-500 italic">
                        **Advertencia:** Este análisis es solo para fines informativos y cosméticos, y no reemplaza el consejo de un dermatólogo o profesional médico.
                    </p>
                </div>
            )}

            {/* Historial */}
            <div className="bg-gray-50 p-6 rounded-xl shadow-lg border border-gray-200">
                <h2 className="text-2xl font-bold text-gray-800 mb-6 flex items-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7.712 7.712A2.5 2.5 0 0121 15.284V17a2 2 0 01-2 2H5a2 2 0 01-2-2V9.284a2.5 2.5 0 01.586-1.414L7 3z" /></svg>
                    Historial del Diario de Piel ({history.length})
                </h2>
                {history.length === 0 ? (
                    <p className="text-gray-500 italic">Aún no tienes entradas en tu diario de piel.</p>
                ) : (
                    <div className="space-y-4">
                        {history.map((item) => (
                            <div key={item.id} className="p-4 bg-white border border-gray-100 rounded-lg shadow-sm hover:shadow-md transition duration-150">
                                <p className="text-sm text-gray-500 mb-1 flex justify-between">
                                    <span>{item.timestamp.toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                                    <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-pink-100 text-pink-800">Con Imagen</span>
                                </p>
                                <p className="text-gray-900 font-semibold mb-2">{item.notes || 'Sin notas adicionales'}</p>
                                <div className="mt-2 text-sm text-gray-700 border-t pt-2 max-h-24 overflow-y-auto">
                                    <h4 className="font-medium text-pink-600">Análisis:</h4>
                                    <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: item.analysis.replace(/\n/g, '<br />') }} />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};


// --- COMPONENTE PRINCIPAL (App) ---

const App = () => {
    const [activeTab, setActiveTab] = useState('home');
    const { db, userId, isAuthReady } = useFirebase();

    // Mensaje de carga inicial mientras se autentica Firebase
    if (!isAuthReady) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-gray-50">
                <div className="flex flex-col items-center p-6 bg-white rounded-xl shadow-lg">
                    <svg className="animate-spin h-8 w-8 text-indigo-600 mb-3" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    <p className="text-gray-700">Conectando con la base de datos...</p>
                </div>
            </div>
        );
    }

    const renderContent = () => {
        if (!db) {
             return <div className="p-4 text-red-600 bg-red-100 rounded-lg">Error: Base de datos no inicializada. Revisa la configuración de Firebase.</div>;
        }

        switch (activeTab) {
            case 'home':
                return <HomeTracker db={db} userId={userId} isAuthReady={isAuthReady} />;
            case 'skin':
                return <SkinJournal db={db} userId={userId} isAuthReady={isAuthReady} />;
            default:
                return <HomeTracker db={db} userId={userId} isAuthReady={isAuthReady} />;
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 font-sans">
            <header className="bg-white shadow-md p-4 sticky top-0 z-10 border-b">
                <div className="max-w-4xl mx-auto flex justify-between items-center">
                    <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">
                        Health IA <span className="text-indigo-600">Tracker</span>
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

            <main className="max-w-4xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
                {renderContent()}
            </main>

            <footer className="text-center p-4 text-sm text-gray-500 border-t mt-8">
                ID de Usuario: <span className="font-mono text-xs break-all">{userId || 'Cargando...'}</span> | App ID: {appId}
            </footer>
        </div>
    );
};

export default App;