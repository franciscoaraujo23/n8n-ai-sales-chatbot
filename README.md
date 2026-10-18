# Chatbot do site da Nautica AI

Assistente do site da Nautica AI, construído em n8n: responde com base numa
base de conhecimento, qualifica o visitante e encaminha-o para uma chamada de
diagnóstico. Guardas determinísticas antes do LLM, custos controlados, erros
visíveis e lógica testada.

A documentação está em [docs/](docs/README.md).

```bash
npm test && npm run test:sql
```
