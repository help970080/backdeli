const cloudinary = require('cloudinary').v2;

// Configuración de Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/**
 * Sube una imagen a Cloudinary
 * @param {Buffer} fileBuffer - Buffer de la imagen
 * @param {string} folder - Carpeta en Cloudinary (ej: 'products', 'stores')
 * @param {string} filename - Nombre del archivo
 * @returns {Promise<string>} URL de la imagen subida
 */
async function uploadImage(fileBuffer, folder = 'general', filename = null) {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: `delivery/${folder}`,
      resource_type: 'auto',
      transformation: [
        { width: 800, height: 800, crop: 'limit' },
        { quality: 'auto:good' },
        { fetch_format: 'auto' }
      ]
    };

    if (filename) {
      uploadOptions.public_id = filename;
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          console.error('Error subiendo a Cloudinary:', error);
          reject(error);
        } else {
          resolve(result.secure_url);
        }
      }
    );

    uploadStream.end(fileBuffer);
  });
}

/**
 * Elimina una imagen de Cloudinary
 * @param {string} imageUrl - URL de la imagen a eliminar
 * @returns {Promise<boolean>} true si se eliminó correctamente
 */
async function deleteImage(imageUrl) {
  try {
    if (!imageUrl || !imageUrl.includes('cloudinary.com')) {
      return false;
    }

    // Extraer el public_id de la URL
    const urlParts = imageUrl.split('/');
    const uploadIndex = urlParts.indexOf('upload');
    
    if (uploadIndex === -1) {
      console.error('URL de Cloudinary inválida');
      return false;
    }
    
    // Obtener todo después de 'upload/vX/' hasta el final
    const pathAfterUpload = urlParts.slice(uploadIndex + 2).join('/');
    // Remover la extensión del archivo
    const publicId = pathAfterUpload.substring(0, pathAfterUpload.lastIndexOf('.')) || pathAfterUpload;
    
    console.log(`Intentando eliminar public_id: ${publicId}`);

    // Determinar el resource_type (image por defecto)
    const resourceType = imageUrl.includes('/video/') ? 'video' : 'image';

    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      invalidate: true
    });
    
    if (result.result === 'not found') {
        console.warn(`Cloudinary: Public ID no encontrado o ya eliminado: ${publicId}`);
        return false;
    }

    console.log(`✅ Imagen eliminada de Cloudinary: ${publicId}`);
    return result.result === 'ok';

  } catch (error) {
    console.error('Error al eliminar imagen de Cloudinary:', error);
    return false; 
  }
}

module.exports = {
  uploadImage,
  deleteImage
};