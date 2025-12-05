import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import multer from "multer";
import bd from "./src/models/index.js";
import redisClient from "./src/lib/redis.js";
import { supabase } from "./src/lib/supabase.js";

dotenv.config();

const { Task, User } = bd;
const app = express();
const port = 3000;

// Configuração do Multer (Upload na memória)
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(cors());

// --- MIDDLEWARE DE AUTENTICAÇÃO ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: "Token não fornecido" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token inválido" });
    req.user = user;
    next();
  });
};

// --- ROTAS DE AUTH & USER ---

// Login (Requisito: /signin)
app.post("/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });

    if (!user) return res.status(400).json({ error: "Usuário não encontrado" });

    // Verifica a senha
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(400).json({ error: "Senha incorreta" });

    // Gera o Token
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '24h' });

    res.json({ token, user: { id: user.id, name: user.name, avatar: user.avatar_url } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro interno no login" });
  }
});

// Cadastro Auxiliar (Para criares o primeiro usuário)
app.post("/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password_hash: hashedPassword });
    res.status(201).json({ id: user.id, email: user.email });
  } catch (error) {
    res.status(400).json({ error: "Erro ao criar usuário. Email já existe?" });
  }
});

// Perfil com Upload (Requisito: /profile + Storage)
app.put("/profile", authenticateToken, upload.single('avatar'), async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    // Upload Supabase
    if (req.file && supabase) {
      const fileName = `${user.id}-${Date.now()}.png`;
      const { error } = await supabase.storage
        .from(process.env.SUPABASE_BUCKET || 'avatars')
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

      if (error) throw error;

      // Pega URL pública
      const { data } = supabase.storage
        .from(process.env.SUPABASE_BUCKET || 'avatars')
        .getPublicUrl(fileName);
        
      user.avatar_url = data.publicUrl;
    }

    if (req.body.name) user.name = req.body.name;
    
    await user.save();
    res.json({ id: user.id, name: user.name, avatar: user.avatar_url });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao atualizar perfil" });
  }
});

// --- ROTAS DE TASKS (COM REDIS) ---

// Listar (CACHE HIT/MISS)
app.get("/tasks", async (req, res) => {
  try {
    const cacheKey = 'tasks:all';
    
    // 1. Tenta Cache (HIT)
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      console.log('Redis: Cache HIT');
      return res.json(JSON.parse(cachedData));
    }

    // 2. Busca Banco (MISS)
    console.log('Redis: Cache MISS');
    const tasks = await Task.findAll();

    // 3. Salva Cache (Expira em 1 hora)
    await redisClient.setEx(cacheKey, 3600, JSON.stringify(tasks));

    res.json(tasks);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao buscar tarefas" });
  }
});

// Criar (INVALIDA CACHE)
app.post("/tasks", async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: "Descrição obrigatória" });
  
  const task = await Task.create({ description, completed: false });
  
  // Limpa o cache
  await redisClient.del('tasks:all');
  
  res.status(201).json(task);
});

// Buscar uma
app.get("/tasks/:id", async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) return res.status(404).json({ error: "Tarefa não encontrada" });
  res.json(task);
});

// Atualizar (INVALIDA CACHE)
app.put("/tasks/:id", async (req, res) => {
  const { description, completed } = req.body;
  const task = await Task.findByPk(req.params.id);
  if (!task) return res.status(404).json({ error: "Tarefa não encontrada" });
  
  await task.update({ description, completed });
  
  // Limpa o cache
  await redisClient.del('tasks:all');

  res.json(task);
});

// Deletar (INVALIDA CACHE)
app.delete("/tasks/:id", async (req, res) => {
  const deleted = await Task.destroy({ where: { id: req.params.id } });
  if (!deleted) return res.status(404).json({ error: "Tarefa não encontrada" });
  
  // Limpa o cache
  await redisClient.del('tasks:all');

  res.status(204).send();
});

// Inicialização
const startServer = async () => {
  try {
    // Conecta Redis
    await redisClient.connect();
    console.log('Redis conectado!');

    // Conecta Banco
    await bd.sequelize.authenticate();
    console.log('Postgres conectado!');

    app.listen(port, '0.0.0.0', () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error('Falha ao iniciar:', error);
  }
};

startServer();