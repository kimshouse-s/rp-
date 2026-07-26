import { LorebookEntry } from '../types';
import { RAGService } from './ragService';

export class LorebookService {
    /**
     * Scans the recent context and triggers matching lorebook entries.
     * Supports recursive scanning up to a max depth.
     */
    public static scan(
        entries: LorebookEntry[],
        recentContext: string,
        recentContextEmbedding?: number[],
        maxRecursionDepth: number = 2
    ): { high: string[], mid: string[], low: string[] } {
        if (!entries || entries.length === 0) {
            return { high: [], mid: [], low: [] };
        }

        const triggeredEntries = new Set<string>();
        const results = { high: [] as string[], mid: [] as string[], low: [] as string[] };
        
        let currentTextToScan = recentContext;
        let currentDepth = 0;

        while (currentDepth <= maxRecursionDepth && currentTextToScan.length > 0) {
            let newlyTriggeredText = "";
            let triggeredInThisPass = false;

            for (const entry of entries) {
                if (triggeredEntries.has(entry.id)) continue;

                // Check probability
                if (Math.random() * 100 > entry.probability) continue;

                let isTriggered = false;

                // 1. Check Regex
                if (entry.regex) {
                    try {
                        const regex = new RegExp(entry.regex, 'i');
                        if (regex.test(currentTextToScan)) {
                            isTriggered = true;
                        }
                    } catch (e) {
                        console.error(`Invalid regex in lorebook entry ${entry.id}:`, e);
                    }
                }

                // 2. Check Keywords (if not already triggered by regex)
                if (!isTriggered && entry.keys && entry.keys.length > 0) {
                    const lowerContext = currentTextToScan.toLowerCase();
                    for (const key of entry.keys) {
                        if (lowerContext.includes(key.toLowerCase())) {
                            isTriggered = true;
                            break;
                        }
                    }
                }

                // 3. Semantic Similarity (Vector matching)
                if (!isTriggered && entry.embedding && recentContextEmbedding) {
                    const similarity = RAGService.cosineSimilarity(recentContextEmbedding, entry.embedding);
                    if (similarity >= 0.55) { // Threshold for semantic match
                        isTriggered = true;
                    }
                }

                if (isTriggered) {
                    triggeredEntries.add(entry.id);
                    const safeDepth = ['high', 'mid', 'low'].includes(entry.depth) ? entry.depth : 'mid';
                    results[safeDepth as 'high' | 'mid' | 'low'].push(entry.content);
                    triggeredInThisPass = true;

                    if (entry.recursable) {
                        newlyTriggeredText += " " + entry.content;
                    }
                }
            }

            // If nothing new was triggered, or no recursable text was added, stop.
            if (!triggeredInThisPass || newlyTriggeredText.trim() === "") {
                break;
            }

            // Prepare for next recursion pass
            currentTextToScan = newlyTriggeredText;
            currentDepth++;
        }

        return results;
    }
}
