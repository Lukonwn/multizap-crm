# ADR 0003: Arquivos no Railway Bucket

**Status:** aceita

**Contexto.** Os volumes da Railway não são compartilhados entre serviços, mas API, worker e gateway precisam acessar os mesmos arquivos (importações, exportações, criativos e mídia).

**Decisão.** Guardar os arquivos num Railway Bucket (compatível com S3), acessado por todos os serviços por uma interface `StorageDriver`. Os backups (dump do banco + arquivos) vão para um **segundo bucket**, independente do armazenamento principal.

**Consequências.** Nenhum serviço depende do filesystem do container. O código usa o protocolo S3 e pode trocar de provedor no futuro.
