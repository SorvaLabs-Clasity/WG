const fs = require('fs');
const file = 'src/routes/graph.ts';
const content = fs.readFileSync(file, 'utf8');

const startStr = '// 5. Query Engine\nrouter.get("/query", async (req: Request, res: Response) => {';
const startIdx = content.indexOf(startStr);
const endIdx = content.indexOf('// Admin tool: trigger aggregation manually');

if (startIdx !== -1 && endIdx !== -1) {
  const newContent = content.slice(0, startIdx) + 
`// 5. Query Engine
router.get("/query", async (req: Request, res: Response) => {
  try {
    const q = req.query.q as string;
    const param = req.query.param as string;
    
    // Create an advanced options object omitting q and param
    const advanced = { ...req.query };
    delete advanced.q;
    delete advanced.param;

    const results = await evaluateSecurityQuery(q, param, advanced, req.user?.accessToken);
    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

` + content.slice(endIdx);
  fs.writeFileSync(file, newContent);
  console.log('Successfully updated');
} else {
  console.log('Could not find boundaries');
}
