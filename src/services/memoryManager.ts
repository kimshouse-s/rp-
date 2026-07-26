import { MemorySlots, LorebookEntry } from '../types';

/**
 * Memory Manager
 * Handles the logic for parsing and applying memory updates from the AI.
 * Implements "Context Folding" by managing Short-term vs Long-term episodes.
 */
export class MemoryManager {
    
    /**
     * Parses the AI response for <mem-update> tags and applies them to the current memory.
     */
    public static applyUpdates(currentMemory: MemorySlots, currentLorebook: LorebookEntry[] | undefined, responseText: string): { newMemory: MemorySlots, newLorebook: LorebookEntry[], updateLog: string } {
        const regex = /<mem-update\s+([^>]+)>([\s\S]*?)<\/mem-update>/gi;
        let match;
        let newMemory: MemorySlots = { persona: '', scenario: '', user_persona: '', state: '', short_term_memory: '', planning: '', ...currentMemory };
        let newLorebook = [...(currentLorebook || [])];
        let updateLog = '';

        while ((match = regex.exec(responseText)) !== null) {
            const attrString = match[1];
            const content = match[2].trim();
            
            const catMatch = attrString.match(/category="([^"]+)"/i);
            const modeMatch = attrString.match(/mode="([^"]+)"/i);
            
            if (catMatch && modeMatch) {
                const category = catMatch[1] as keyof MemorySlots;
                const mode = modeMatch[1];
                if (newMemory[category] !== undefined) {
                    newMemory[category] = this.patchMemory(newMemory[category], content, mode);
                    updateLog += `[${category}] (${mode})\n${content}\n\n`;
                }
            }
        }

        const loreRegex = /<lorebook-update\s+([^>]+)>([\s\S]*?)<\/lorebook-update>/gi;
        while ((match = loreRegex.exec(responseText)) !== null) {
            const attrString = match[1];
            const content = match[2].trim();
            
            const actionMatch = attrString.match(/action="([^"]+)"/i);
            const keysMatch = attrString.match(/keys="([^"]+)"/i);
            const depthMatch = attrString.match(/depth="([^"]+)"/i);
            
            if (!actionMatch || !keysMatch) continue;
            
            const action = actionMatch[1].toLowerCase(); // 'add', 'update', or 'delete'
            const keys = keysMatch[1].split(',').map(k => k.trim()).filter(k => k.length > 0);
            
            let depth = depthMatch ? depthMatch[1].toLowerCase() as 'high' | 'mid' | 'low' : 'mid';
            if (!['high', 'mid', 'low'].includes(depth)) {
                depth = 'mid';
            }

            if (action === 'delete') {
                const initialLength = newLorebook.length;
                newLorebook = newLorebook.filter(entry => !entry.keys.some(k => keys.includes(k)));
                if (newLorebook.length < initialLength) {
                    updateLog += `[Lorebook Deleted] Keys: ${keys.join(', ')}\n\n`;
                }
            } else if (action === 'add' || action === 'update') {
                // Check if an entry with overlapping keys exists
                const existingIndex = newLorebook.findIndex(entry => entry.keys.some(k => keys.includes(k)));
                
                if (existingIndex >= 0 && action === 'update') {
                    newLorebook[existingIndex] = {
                        ...newLorebook[existingIndex],
                        keys: Array.from(new Set([...newLorebook[existingIndex].keys, ...keys])),
                        content,
                        depth
                    };
                    updateLog += `[Lorebook Updated] Keys: ${keys.join(', ')}\n${content}\n\n`;
                } else {
                    const newEntry: LorebookEntry = {
                        id: `lore_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        keys,
                        content,
                        depth,
                        probability: 100,
                        recursable: false
                    };
                    newLorebook.push(newEntry);
                    updateLog += `[Lorebook Added] Keys: ${keys.join(', ')}\n${content}\n\n`;
                }
            }
        }

        return { newMemory, newLorebook, updateLog };
    }

    /**
     * Applies the specific patch logic based on the mode.
     */
    private static patchMemory(original: string, update: string, mode: string): string {
        if (mode === 'overwrite') {
            return update;
        }
        
        if (mode === 'append') {
            return original ? `${original}\n\n${update}` : update;
        }

        if (mode === 'patch') {
            // Try JSON merge first
            try {
                const cleanOrig = original.replace(/```json\n?/g, '').replace(/```/g, '').trim();
                const cleanUpdate = update.replace(/```json\n?/g, '').replace(/```/g, '').trim();
                const origJson = JSON.parse(cleanOrig);
                const updateJson = JSON.parse(cleanUpdate);
                if (typeof origJson === 'object' && origJson !== null && typeof updateJson === 'object' && updateJson !== null) {
                    return JSON.stringify({ ...origJson, ...updateJson }, null, 2);
                }
            } catch (e) {
                // Not JSON, fall through to smart patch
            }

            // Smart Patching for [[Header]] blocks
            return this.smartPatch(original, update);
        }

        return original;
    }

    /**
     * Smart Patch logic (ported and improved from original index.tsx)
     */
    private static smartPatch(original: string, update: string): string {
        const origStr = typeof original === 'string' ? original : String(original || '');
        const updateStr = typeof update === 'string' ? update : String(update || '');

        if (!updateStr.includes('[[') && !updateStr.includes('->')) {
            return origStr ? `${origStr}\n\n${updateStr}` : updateStr;
        }

        const blockRegex = /(\[\[.*?\]\])([\s\S]*?)(?=(\[\[|$))/gi;
        const originalMap = new Map<string, string>();
        
        let preText = '';
        const firstMatch = origStr.search(blockRegex);
        if (firstMatch > 0) {
            preText = origStr.substring(0, firstMatch);
        } else if (firstMatch === -1 && origStr.trim()) {
            preText = origStr;
        }

        const originalMatches = [...origStr.matchAll(blockRegex)];
        originalMatches.forEach(m => {
            originalMap.set(m[1].trim(), m[0].trim());
        });

        const updateMatches = [...updateStr.matchAll(blockRegex)];
        updateMatches.forEach(m => {
            const header = m[1].trim();
            const content = m[0].trim();
            originalMap.set(header, content);
        });

        let result = preText.trim();
        originalMap.forEach(content => {
            if (result) result += '\n\n';
            result += content;
        });

        return result;
    }

    /**
     * Parses the custom prompt to extract initial memory slots.
     * This allows users to configure the world and character by editing the custom prompt text.
     */
    public static parsePromptToMemory(prompt: string): Partial<MemorySlots> {
        const memory: Partial<MemorySlots> = {};
        
        // Helper to extract content between headers
        const extractSection = (headerRegex: RegExp): string | undefined => {
            const match = prompt.match(headerRegex);
            if (!match) return undefined;
            
            const startIndex = match.index! + match[0].length;
            // Find the next header (## number. or ---)
            // We search for the next section header or the end of the data protocol section
            const nextMatch = prompt.substring(startIndex).match(/(\n## \d+\.|---)/);
            
            const endIndex = nextMatch ? startIndex + nextMatch.index! : prompt.length;
            return prompt.substring(startIndex, endIndex).trim();
        };

        // 1. Persona
        const personaContent = extractSection(/## 1\. \[(persona|core_identity)\][^\n]*/);
        if (personaContent) memory.persona = personaContent;

        // 2. Scenario
        const scenarioContent = extractSection(/## 2\. \[(scenario|blueprint)\][^\n]*/);
        if (scenarioContent) memory.scenario = scenarioContent;

        // 3. User Persona
        const userPersonaContent = extractSection(/## 3\. \[(user_persona|user_req)\][^\n]*/);
        if (userPersonaContent) memory.user_persona = userPersonaContent;

        // 4. State
        const stateContent = extractSection(/## 4\. \[(state|current_state)\][^\n]*/);
        if (stateContent) memory.state = stateContent;

        // 5. Episode
        const episodeContent = extractSection(/## 5\. \[short_term_memory\][^\n]*/);
        if (episodeContent) memory.short_term_memory = episodeContent;

        // 6. Planning
        const planningContent = extractSection(/## 6\. \[planning\][^\n]*/);
        if (planningContent) memory.planning = planningContent;

        return memory;
    }
}
