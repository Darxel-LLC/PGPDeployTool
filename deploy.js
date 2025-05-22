const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

async function splitAndUploadZip(zipFilePath, partSizeMB, uploadUrl, game, description) {
  const partSizeBytes = partSizeMB * 1024 * 1024;
  let fileHandle = null;

  try {
    const stats = await fs.stat(zipFilePath);
    const totalSize = stats.size;
    let start = 0;
    let partNumber = 0;

    fileHandle = await fs.open(zipFilePath, 'r');

    const sessionID = uuidv4();
    console.log("ID сессии:", sessionID);
    while (start < totalSize) {
      const end = Math.min(start + partSizeBytes, totalSize);
      const chunkSize = end - start;
      const buffer = Buffer.alloc(chunkSize);
      await fileHandle.read(buffer, 0, chunkSize, start);
      partNumber++;
      const partFileName = `${path.basename(zipFilePath)}.part.${partNumber.toString().padStart(3, '0')}`;
      console.log(`Создается и отправляется часть ${partNumber}: ${partFileName} (${chunkSize} байт)`);

      // Отправка части на сервер (пример с HTTP POST-запросом)
      try {
        const response = await axios.post(uploadUrl, buffer, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Part-Number': partNumber,
            'X-Total-Parts': Math.ceil(totalSize / partSizeBytes),
            'X-File-Name': sessionID,
            'X-Game-Name': game,
            'X-Description': description       
          },
        });
        console.log(`Часть ${partNumber} успешно отправлена. Статус: ${response.status}`);
      } catch (error) {
        console.error(`Ошибка при отправке части ${partNumber}:`, error.message);
        console.log(`Повторная отправка через 10 секунд...`);
        await new Promise((resolve)=>setTimeout(resolve, 10000));
        console.log(`Попытка переотправить часть ${partNumber}: ${partFileName} (${chunkSize} байт)`);
        try {
            const response = await axios.post(uploadUrl, buffer, {
              headers: {
                'Content-Type': 'application/octet-stream',
                'X-Part-Number': partNumber,
                'X-Total-Parts': Math.ceil(totalSize / partSizeBytes),
                'X-File-Name': sessionID,            
              },
            });
            console.log(`Часть ${partNumber} успешно отправлена. Статус: ${response.status}`);
          } catch (error) {
            console.error(`Ошибка при отправке части ${partNumber}:`, error.message);
            console.error('Не удалось повторно отправить часть ', partNumber, ", завершение операции");
            return;
          }
      }

      start = end;
    }
    console.log('Разбиение и отправка архива завершены.', sessionID);

  } catch (error) {
    console.error('Произошла ошибка:', error);
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

module.exports = { splitAndUploadZip };
