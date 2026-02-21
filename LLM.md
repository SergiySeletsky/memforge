# Mem0 - The Memory Layer for Personalized AI

## Overview

Mem0 ("mem-zero") is an intelligent memory layer that enhances AI assistants and agents with persistent, personalized memory capabilities. It enables AI systems to remember user preferences, adapt to individual needs, and continuously learn over time—making it ideal for customer support chatbots, AI assistants, and autonomous systems.

**Key Benefits:**
- +26% Accuracy over OpenAI Memory on LOCOMO benchmark
- 91% Faster responses than full-context approaches
- 90% Lower token usage than full-context methods

## Installation

```bash
npm install mem0ai
```

## Quick Start

### TypeScript - Client SDK
```typescript
import { MemoryClient } from 'mem0ai';

const client = new MemoryClient({ apiKey: 'your-api-key' });

// Add memory
const memories = await client.add([
  { role: 'user', content: 'My name is John' }
], { user_id: 'john' });

// Search memories
const results = await client.search('What is my name?', { user_id: 'john' });
```

### TypeScript - OSS SDK
```typescript
import { Memory } from 'mem0ai/oss';

const memory = new Memory({
  embedder: { provider: 'openai', config: { apiKey: 'key' } },
  vectorStore: { provider: 'memory', config: { dimension: 1536 } },
  llm: { provider: 'openai', config: { apiKey: 'key' } }
});

const result = await memory.add('My name is John', { userId: 'john' });
```

## Core API Reference

## Configuration System

### MemoryConfig

```typescript
import { Memory } from 'mem0ai/oss';

const memory = new Memory({
  vectorStore: { provider: 'qdrant', config: { host: 'localhost', port: 6333 } },
  llm: { provider: 'openai', config: { model: 'gpt-4.1-nano-2025-04-14' } },
  embedder: { provider: 'openai', config: { model: 'text-embedding-3-small' } },
  graphStore: { provider: 'neo4j', config: { url: 'bolt://localhost:7687', username: 'neo4j', password: 'password' } }, // optional
  customFactExtractionPrompt: 'Custom prompt...',
  customUpdateMemoryPrompt: 'Custom prompt...',
});
```

### Supported Providers

#### LLM Providers (19 supported)
- **openai** - OpenAI GPT models (default)
- **anthropic** - Claude models
- **gemini** - Google Gemini
- **groq** - Groq inference
- **ollama** - Local Ollama models
- **together** - Together AI
- **aws_bedrock** - AWS Bedrock models
- **azure_openai** - Azure OpenAI
- **litellm** - LiteLLM proxy
- **deepseek** - DeepSeek models
- **xai** - xAI models
- **sarvam** - Sarvam AI
- **lmstudio** - LM Studio local server
- **vllm** - vLLM inference server
- **langchain** - LangChain integration
- **openai_structured** - OpenAI with structured output
- **azure_openai_structured** - Azure OpenAI with structured output

#### Embedding Providers (10 supported)
- **openai** - OpenAI embeddings (default)
- **ollama** - Ollama embeddings
- **huggingface** - HuggingFace models
- **azure_openai** - Azure OpenAI embeddings
- **gemini** - Google Gemini embeddings
- **vertexai** - Google Vertex AI
- **together** - Together AI embeddings
- **lmstudio** - LM Studio embeddings
- **langchain** - LangChain embeddings
- **aws_bedrock** - AWS Bedrock embeddings

#### Vector Store Providers (19 supported)
- **qdrant** - Qdrant vector database (default)
- **chroma** - ChromaDB
- **pinecone** - Pinecone vector database
- **pgvector** - PostgreSQL with pgvector
- **mongodb** - MongoDB Atlas Vector Search
- **milvus** - Milvus vector database
- **weaviate** - Weaviate
- **faiss** - Facebook AI Similarity Search
- **redis** - Redis vector search
- **elasticsearch** - Elasticsearch
- **opensearch** - OpenSearch
- **azure_ai_search** - Azure AI Search
- **vertex_ai_vector_search** - Google Vertex AI Vector Search
- **upstash_vector** - Upstash Vector
- **supabase** - Supabase vector
- **baidu** - Baidu vector database
- **langchain** - LangChain vector stores
- **s3_vectors** - Amazon S3 Vectors
- **databricks** - Databricks vector stores

#### Graph Store Providers (4 supported)
- **neo4j** - Neo4j graph database
- **memgraph** - Memgraph
- **neptune** - AWS Neptune Analytics
- **kuzu** - Kuzu Graph database

### Configuration Examples

#### OpenAI Configuration
```typescript
import { Memory } from 'mem0ai/oss';

const memory = new Memory({
  llm: { provider: 'openai', config: { model: 'gpt-4.1-nano-2025-04-14', temperature: 0.1, maxTokens: 1000 } },
  embedder: { provider: 'openai', config: { model: 'text-embedding-3-small' } },
});
```

#### Local Setup with Ollama
```typescript
const memory = new Memory({
  llm: { provider: 'ollama', config: { model: 'llama3.1:8b', ollamaBaseUrl: 'http://localhost:11434' } },
  embedder: { provider: 'ollama', config: { model: 'nomic-embed-text' } },
  vectorStore: { provider: 'chroma', config: { collectionName: 'my_memories', path: './chroma_db' } },
});
```

#### Graph Memory with Neo4j
```typescript
const memory = new Memory({
  graphStore: { provider: 'neo4j', config: { url: 'bolt://localhost:7687', username: 'neo4j', password: 'password', database: 'neo4j' } },
});
```

#### Enterprise Setup
```typescript
const memory = new Memory({
  llm: { provider: 'azure_openai', config: { model: 'gpt-4', azureEndpoint: 'https://your-resource.openai.azure.com/', apiKey: process.env.AZURE_OPENAI_API_KEY!, apiVersion: '2024-02-01' } },
  vectorStore: { provider: 'pinecone', config: { apiKey: process.env.PINECONE_API_KEY!, indexName: 'mem0-index', dimension: 1536 } },
});
```

#### LLM Providers
- **OpenAI** - GPT-4, GPT-3.5-turbo, and structured outputs
- **Anthropic** - Claude models with advanced reasoning
- **Google AI** - Gemini models for multimodal applications
- **AWS Bedrock** - Enterprise-grade AWS managed models
- **Azure OpenAI** - Microsoft Azure hosted OpenAI models
- **Groq** - High-performance LPU optimized models
- **Together** - Open-source model inference platform
- **Ollama** - Local model deployment for privacy
- **vLLM** - High-performance inference framework
- **LM Studio** - Local model management
- **DeepSeek** - Advanced reasoning models
- **Sarvam** - Indian language models
- **XAI** - xAI models
- **LiteLLM** - Unified LLM interface
- **LangChain** - LangChain LLM integration

#### Vector Store Providers
- **Chroma** - AI-native open-source vector database
- **Qdrant** - High-performance vector similarity search
- **Pinecone** - Managed vector database with serverless options
- **Weaviate** - Open-source vector search engine
- **PGVector** - PostgreSQL extension for vector search
- **Milvus** - Open-source vector database for scale
- **Redis** - Real-time vector storage with Redis Stack
- **Supabase** - Open-source Firebase alternative
- **Upstash Vector** - Serverless vector database
- **Elasticsearch** - Distributed search and analytics
- **OpenSearch** - Open-source search and analytics
- **FAISS** - Facebook AI Similarity Search
- **MongoDB** - Document database with vector search
- **Azure AI Search** - Microsoft's search service
- **Vertex AI Vector Search** - Google Cloud vector search
- **Databricks Vector Search** - Delta Lake integration
- **Baidu** - Baidu vector database
- **LangChain** - LangChain vector store integration

#### Embedding Providers
- **OpenAI** - High-quality text embeddings
- **Azure OpenAI** - Enterprise Azure-hosted embeddings
- **Google AI** - Gemini embedding models
- **AWS Bedrock** - Amazon embedding models
- **Hugging Face** - Open-source embedding models
- **Vertex AI** - Google Cloud enterprise embeddings
- **Ollama** - Local embedding models
- **Together** - Open-source model embeddings
- **LM Studio** - Local model embeddings
- **LangChain** - LangChain embedder integration

## TypeScript/JavaScript SDK

### Client SDK (Hosted Platform)

```typescript
import { MemoryClient } from 'mem0ai';

const client = new MemoryClient({
  apiKey: 'your-api-key',
  host: 'https://api.mem0.ai',  // optional
  organizationId: 'org-id',     // optional
  projectId: 'project-id'       // optional
});

// Core operations
const memories = await client.add([
  { role: 'user', content: 'I love pizza' }
], { user_id: 'user123' });

const results = await client.search('food preferences', { user_id: 'user123' });
const memory = await client.get('memory-id');
const allMemories = await client.getAll({ user_id: 'user123' });

// Management operations
await client.update('memory-id', 'Updated content');
await client.delete('memory-id');
await client.deleteAll({ user_id: 'user123' });

// Batch operations
await client.batchUpdate([{ id: 'mem1', text: 'new text' }]);
await client.batchDelete(['mem1', 'mem2']);

// User management
const users = await client.users();
await client.deleteUsers({ user_ids: ['user1', 'user2'] });

// Webhooks
const webhooks = await client.getWebhooks();
await client.createWebhook({
  url: 'https://your-webhook.com',
  name: 'My Webhook',
  eventTypes: ['memory.created', 'memory.updated']
});
```

### OSS SDK (Self-Hosted)

```typescript
import { Memory } from 'mem0ai/oss';

const memory = new Memory({
  embedder: {
    provider: 'openai',
    config: { apiKey: 'your-key' }
  },
  vectorStore: {
    provider: 'qdrant',
    config: { host: 'localhost', port: 6333 }
  },
  llm: {
    provider: 'openai',
    config: { model: 'gpt-4.1-nano' }
  }
});

// Core operations
const result = await memory.add('I love pizza', { userId: 'user123' });
const searchResult = await memory.search('food preferences', { userId: 'user123' });
const memoryItem = await memory.get('memory-id');
const allMemories = await memory.getAll({ userId: 'user123' });

// Management
await memory.update('memory-id', 'Updated content');
await memory.delete('memory-id');
await memory.deleteAll({ userId: 'user123' });

// History and reset
const history = await memory.history('memory-id');
await memory.reset();
```

### Key TypeScript Types

```typescript
interface Message {
  role: 'user' | 'assistant';
  content: string | MultiModalMessages;
}

interface Memory {
  id: string;
  memory?: string;
  user_id?: string;
  categories?: string[];
  created_at?: Date;
  updated_at?: Date;
  metadata?: any;
  score?: number;
}

interface MemoryOptions {
  user_id?: string;
  agent_id?: string;
  app_id?: string;
  run_id?: string;
  metadata?: Record<string, any>;
  filters?: Record<string, any>;
  api_version?: 'v1' | 'v2';
  infer?: boolean;
  enable_graph?: boolean;
}

interface SearchResult {
  results: Memory[];
  relations?: any[];
}
```

## Advanced Features

### Graph Memory

Graph memory enables relationship tracking between entities mentioned in conversations.

```typescript
const result = await memory.add(
  'John works at OpenAI and is friends with Sarah',
  { userId: 'user123' }
);
console.log(result.results);   // Memory entries
console.log(result.relations); // Graph relationships
```

**Supported Graph Databases:**
- **Neo4j**: Full-featured graph database with Cypher queries
- **Memgraph**: High-performance in-memory graph database
- **Neptune**: AWS managed graph database service
- **kuzu** - OSS Kuzu Graph database

### Multimodal Memory

Store and retrieve memories from text, images, and PDFs.

```typescript
const messages = [
  { role: 'user', content: 'This is my travel setup' },
  { role: 'user', content: { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } } },
];
await client.add(messages, { userId: 'user123' });

// PDF
const pdfMessage = { role: 'user', content: { type: 'pdf_url', pdf_url: { url: 'https://example.com/document.pdf' } } };
await client.add([pdfMessage], { userId: 'user123' });
```

### Procedural Memory

Store step-by-step procedures and workflows.

```typescript
await memory.add(
  'To deploy the app: 1. Run tests 2. Build Docker image 3. Push to registry 4. Update k8s manifests',
  { userId: 'developer123', memoryType: 'procedural_memory' }
);
const procedures = await memory.search('How to deploy?', { userId: 'developer123' });
```

### Custom Prompts

```typescript
import { Memory } from 'mem0ai/oss';

const customExtractionPrompt = `
Extract key facts from the conversation focusing on:
1. Personal preferences
2. Technical skills
3. Project requirements
4. Important dates and deadlines

Conversation: {messages}
`;

const memory = new Memory({ customFactExtractionPrompt: customExtractionPrompt });
```


## Common Usage Patterns

### 1. Personal AI Assistant

```typescript
import OpenAI from 'openai';
import { Memory } from 'mem0ai/oss';

const memory = new Memory();
const openai = new OpenAI();

async function chat(userInput: string, userId: string): Promise<string> {
  const { results } = await memory.search(userInput, { userId, limit: 5 });
  const context = results.map((m: any) => `- ${m.memory}`).join('\n');

  const prompt = `Context from previous conversations:\n${context}\n\nUser: ${userInput}\nAssistant:`;
  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-nano-2025-04-14',
    messages: [{ role: 'user', content: prompt }],
  });
  const response = completion.choices[0].message.content ?? '';

  await memory.add([
    { role: 'user', content: userInput },
    { role: 'assistant', content: response },
  ], { userId });

  return response;
}
```

### 2. Customer Support Bot

```typescript
import MemoryClient from 'mem0ai';

const memClient = new MemoryClient({ apiKey: process.env.MEM0_API_KEY! });

async function handleTicket(customerId: string, issue: string): Promise<string> {
  const history = await memClient.search(issue, { user_id: customerId, limit: 10 });
  const similarIssues = history.filter((m: any) => m.score > 0.8);
  const context = similarIssues.length > 0
    ? `Previous similar issues: ${similarIssues[0].memory}`
    : 'No previous similar issues found.';

  const response = await generateSupportResponse(issue, context); // your LLM call

  await memClient.add([
    { role: 'user', content: `Issue: ${issue}` },
    { role: 'assistant', content: response },
  ], { user_id: customerId, metadata: { category: 'support_ticket', timestamp: new Date().toISOString() } });

  return response;
}
```

### 3. Learning Assistant

```typescript
async function studySession(studentId: string, topic: string, content: string) {
  await memory.add(`Studied ${topic}: ${content}`, {
    userId: studentId,
    metadata: { topic, sessionDate: new Date().toISOString(), type: 'study_session' },
  });
}

async function trackProgress(studentId: string) {
  const sessions = await memory.getAll({ userId: studentId });
  const topicsStudied: Record<string, number> = {};
  for (const session of sessions.results) {
    const topic = session.metadata?.topic;
    if (topic) topicsStudied[topic] = (topicsStudied[topic] ?? 0) + 1;
  }
  return { totalSessions: sessions.results.length, topicsCovered: Object.keys(topicsStudied).length, topicFrequency: topicsStudied };
}
```

### 4. Multi-Agent System

```typescript
async function collaborativeTask(task: string, sessionId: string) {
  const researchResults = await researchAgent.research(task);
  await memory.add(`Research findings: ${researchResults}`, {
    agentId: 'researcher', runId: sessionId, metadata: { phase: 'research' },
  });

  const researchContext = await memory.search('research findings', { runId: sessionId });
  const draft = await writerAgent.write(task, researchContext);
  await memory.add(`Draft content: ${draft}`, {
    agentId: 'writer', runId: sessionId, metadata: { phase: 'writing' },
  });

  const allContext = await memory.getAll({ runId: sessionId });
  return reviewAgent.review(draft, allContext);
}
```

## Best Practices

### 1. Memory Organization

```typescript
const userId = `user_${userEmail.replace('@', '_')}`;
const agentId = `agent_${agentName}`;
const runId = `session_${new Date().toISOString().replace(/[:.]/g, '_')}`;

const metadata = {
  category: 'customer_support',
  priority: 'high',
  department: 'technical',
  timestamp: new Date().toISOString(),
  source: 'chat_widget',
};

await memory.add(
  'Customer John Smith reported login issues with 2FA on mobile app. Resolved by clearing app cache.',
  { userId: customerId, metadata }
);
```

### 2. Search Optimization

```typescript
const results = await memory.search('login issues mobile app', { userId: customerId, limit: 5, threshold: 0.7 });
const allMemories = await memory.getAll({ userId, limit: 10 });
```

### 3. Memory Lifecycle Management

```typescript
async function cleanupOldMemories(memoryClient: any, maxAgeDays = 90) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);
  const all = await memoryClient.getAll();
  for (const mem of all.results) {
    if (new Date(mem.created_at) < cutoff) await memoryClient.delete(mem.id);
  }
}

async function archiveMemory(memoryClient: any, memoryId: string) {
  const mem = await memoryClient.get(memoryId);
  await memoryClient.update(memoryId, { metadata: { ...mem.metadata, archived: true, archiveDate: new Date().toISOString() } });
}
```

### 4. Error Handling

```typescript
async function safeMemoryOperation<T>(operation: () => Promise<T>): Promise<T | { results: never[] }> {
  try {
    return await operation();
  } catch (err) {
    console.error('Memory operation failed:', err);
    return { results: [] };
  }
}

const results = await safeMemoryOperation(() => memory.search(query, { userId }));
```

### 5. Performance Optimization

```typescript
// Cache frequently accessed memories
const cache = new Map<string, any>();

async function getCachedPreferences(userId: string) {
  if (cache.has(userId)) return cache.get(userId);
  const prefs = await memory.search('preferences settings', { userId, limit: 5 });
  cache.set(userId, prefs);
  return prefs;
}
```


## Integration Examples

### LangChain Integration

```typescript
import { MemoryClient } from 'mem0ai';

// Use Mem0 inside a LangChain-compatible wrapper
class Mem0MemoryStore {
  private client = new MemoryClient({ apiKey: process.env.MEM0_API_KEY! });
  private userId: string;

  constructor(userId: string) { this.userId = userId; }

  async saveContext(userMessage: string, assistantMessage: string) {
    await this.client.add([
      { role: 'user', content: userMessage },
      { role: 'assistant', content: assistantMessage },
    ], { user_id: this.userId });
  }

  async loadRelevantMemories(query: string): Promise<string> {
    const results = await this.client.search(query, { user_id: this.userId, limit: 3 });
    return results.map((m: any) => `- ${m.memory}`).join('\n');
  }
}
```

### Next.js API Route

```typescript
// app/api/chat/route.ts (Next.js App Router)
import { NextRequest, NextResponse } from 'next/server';
import MemoryClient from 'mem0ai';

const memClient = new MemoryClient({ apiKey: process.env.MEM0_API_KEY! });

export async function POST(req: NextRequest) {
  try {
    const { messages, userId, metadata } = await req.json();
    const result = await memClient.add(messages, { user_id: userId, metadata });
    return NextResponse.json({ status: 'success', result });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// GET /api/memories?userId=alice
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId');
  const memories = await memClient.getAll({ user_id: userId ?? undefined });
  return NextResponse.json({ memories });
}
```

## Troubleshooting

### Common Issues

1. **Memory Not Found**
   ```typescript
   const mem = await memoryClient.get(memoryId);
   if (!mem) console.log(`Memory ${memoryId} not found`);
   ```

2. **Search Returns No Results**
   ```typescript
   const results = await memory.search(query, { userId, threshold: 0.5 });
   const all = await memory.getAll({ userId });
   if (!all.results.length) console.log('No memories found for user');
   ```

3. **Configuration Issues**
   ```typescript
   try {
     const memory = new Memory(config);
     await memory.add('Test memory', { userId: 'test' });
     console.log('Configuration valid');
   } catch (err) {
     console.error('Configuration error:', err);
   }
   ```

4. **API Rate Limits**
   ```typescript
   async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, delay = 1000): Promise<T> {
     for (let attempt = 0; attempt < maxRetries; attempt++) {
       try { return await fn(); }
       catch (err: any) {
         if (err.message?.toLowerCase().includes('rate limit') && attempt < maxRetries - 1) {
           await new Promise(r => setTimeout(r, delay * 2 ** attempt));
           continue;
         }
         throw err;
       }
     }
     throw new Error('Max retries exceeded');
   }
   ```

### Performance Tips

1. **Optimize Vector Store Configuration**
   ```typescript
   const memory = new Memory({
     vectorStore: {
       provider: 'qdrant',
       config: { host: 'localhost', port: 6333, collectionName: 'memories', embeddingModelDims: 1536, distance: 'cosine' },
     },
   });
   ```

2. **Batch Processing**
   ```typescript
   async function batchAddMemories(memClient: any, conversations: any[], userId: string, batchSize = 10) {
     for (let i = 0; i < conversations.length; i += batchSize) {
       const batch = conversations.slice(i, i + batchSize);
       await Promise.all(batch.map(conv => memClient.add(conv, { userId })));
       await new Promise(r => setTimeout(r, 100));
     }
   }
   ```

3. **Memory Cleanup**
   ```typescript
   async function cleanupMemories(memClient: any, userId: string, maxMemories = 1000) {
     const all = await memClient.getAll({ userId });
     if (all.results.length > maxMemories) {
       const sorted = [...all.results].sort((a: any, b: any) =>
         new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
       );
       await Promise.all(sorted.slice(maxMemories).map((m: any) => memClient.delete(m.id)));
     }
   }
   ```

## Resources

- **Documentation**: https://docs.mem0.ai
- **GitHub Repository**: https://github.com/mem0ai/mem0
- **Discord Community**: https://mem0.dev/DiG
- **Platform**: https://app.mem0.ai
- **Research Paper**: https://mem0.ai/research
- **Examples**: https://github.com/mem0ai/mem0/tree/main/examples

## License

Mem0 is available under the Apache 2.0 License. See the [LICENSE](https://github.com/mem0ai/mem0/blob/main/LICENSE) file for more details.

