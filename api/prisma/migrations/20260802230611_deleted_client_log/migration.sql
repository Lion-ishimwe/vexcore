-- CreateTable
CREATE TABLE `DeletedClient` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `clientId` INTEGER NOT NULL,
    `company` VARCHAR(191) NOT NULL,
    `country` VARCHAR(191) NULL,
    `plan` VARCHAR(191) NULL,
    `status` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `signupAt` DATETIME(3) NULL,
    `deletedBy` VARCHAR(191) NOT NULL,
    `removed` JSON NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
