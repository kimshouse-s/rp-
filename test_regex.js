const str = `( update_memory: category="state", mode="patch", content={"Iris": {"Emotion": {"primary": "confused", "hidden": "indebted", "intensity": 9}, "Relationship": {"index": 15, "recent_shift": "perplexed_by_kindness"}}} )`;
const regex = /[\[\(]\s*update_memory:\s*category="([^"]+)",\s*mode="([^"]+)",\s*content=({[\s\S]*?}|"[\s\S]*?")\s*[\]\)]/g;
let match;
while ((match = regex.exec(str)) !== null) {
  console.log("Content:", match[3]);
}
