import { GoogleGenAI } from '@google/genai';
import { Message, VectorMemoryChunk } from '../types';

export class RAGService {
    /**
     * Calculates cosine similarity between two vectors.
     */
    public static cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < (vecA?.length || 0); i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Generates an embedding for a given text.
     */
    public static async generateEmbedding(ai: GoogleGenAI, text: string): Promise<number[]> {
        try {
            const result = await ai.models.embedContent({
                model: 'gemini-embedding-2-preview',
                contents: text,
            });
            return result.embeddings?.[0]?.values || [];
        } catch (error) {
            console.error("Error generating embedding:", error);
            return [];
        }
    }

    /**
     * Rephrases recent dialogue into standalone facts (Propositionalization).
     */
    // rephraseToFacts removed as RAG updates are now handled via AI tags

    /**
     * Queries the vector memory for relevant chunks based on the current context.
     */
    public static async queryMemory(
        ai: GoogleGenAI,
        memory: VectorMemoryChunk[],
        queryText: string,
        threshold: number = 0.55,
        topK: number = 15
    ): Promise<{ results: string[], updatedMemory: VectorMemoryChunk[] }> {
        if (!memory || memory.length === 0) return { results: [], updatedMemory: [] };

        const now = Date.now();

        // If threshold is 0.0, unconditionally load the most recent memories without embedding search
        if (threshold <= 0.0) {
            const recent = [...memory]
                .sort((a, b) => a.timestamp - b.timestamp) // chronological order for better context flow
                .slice(-topK);
                
            const updatedMemory = memory.map(chunk => {
                if (recent.some(r => r.id === chunk.id)) {
                    return {
                        ...chunk,
                        accessCount: (chunk.accessCount || 0) + 1,
                        lastAccessed: now
                    };
                }
                return chunk;
            });
                
            return { results: recent.map(c => c.text), updatedMemory };
        }

        const queryEmbedding = await this.generateEmbedding(ai, queryText);
        if (queryEmbedding.length === 0) return { results: [], updatedMemory: memory };

        const ONE_DAY = 24 * 60 * 60 * 1000;

        const scoredChunks = memory.map(chunk => {
            const baseScore = this.cosineSimilarity(queryEmbedding, chunk.embedding);
            
            // MOOM framework: Competition-Inhibition
            // Time decay based on last accessed time (or creation if never accessed)
            const referenceTime = chunk.lastAccessed || chunk.timestamp;
            const ageDays = (now - referenceTime) / ONE_DAY;
            
            // 1. Decay: gradually drops over time
            let timeDecay = ageDays * 0.005; 
            
            // 2. Reinforcement: boost based on access count
            const accesses = chunk.accessCount || 0;
            const reinforcementBoost = accesses * 0.02; // Boost per access
            
            // 3. Inhibition: if it's old and never accessed, penalize it heavily
            let inhibitionPenalty = 0;
            if (accesses === 0 && ageDays > 14) {
                inhibitionPenalty = 0.2; // Halve its chances
            }
            
            // Time boost for freshly created items to keep recent context flowing
            const creationAgeDays = (now - chunk.timestamp) / ONE_DAY;
            const freshBoost = Math.max(0, 0.05 * Math.exp(-creationAgeDays / 7));

            let finalScore = baseScore + freshBoost + reinforcementBoost - timeDecay - inhibitionPenalty;
            
            return {
                id: chunk.id,
                text: chunk.text,
                score: finalScore,
                baseScore
            };
        });

        // Filter by threshold and sort descending
        const relevantChunks = scoredChunks
            .filter(c => c.score >= threshold)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
            
        // Update access counts and last accessed for relevant chunks
        const relevantIds = new Set(relevantChunks.map(c => c.id));
        const updatedMemory = memory.map(chunk => {
            if (relevantIds.has(chunk.id)) {
                return {
                    ...chunk,
                    accessCount: (chunk.accessCount || 0) + 1,
                    lastAccessed: now
                };
            }
            return chunk;
        });

        return { results: relevantChunks.map(c => c.text), updatedMemory };
    }
}
